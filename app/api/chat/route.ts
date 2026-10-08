import 'server-only'
import { streamText, convertToModelMessages, stepCountIs, type UIMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'
import { requireUserId } from '@/lib/api/auth'
import { withApiLogging, logEvent } from '@/lib/api/observability'
import { createGuardedAgentTools } from '@/lib/agent/tools'
import { isChatMode, type ChatMode } from '@/lib/agent/prompt'
import { collectPaths, unverifiedCitations } from '@/lib/agent/citations'
import {
    getChatById,
    saveUserMessage,
    upsertAssistantMessage,
    updateChatSummary,
    extractTextFromParts,
} from '@/lib/repositories/chatRepository'
import { chatModels, DEFAULT_CHAT_MODEL } from '@/lib/model'
import {
    DEFAULT_SUMMARY_MODEL,
    getSystemPromptWithSummary,
    summarizeHistory,
} from '@/lib/agent/summary'

/**
 * 与 OpenRouter 的 OpenAI 兼容层对接。
 * 用 @ai-sdk/openai 的 createOpenAI + baseURL 即可，不需要额外的 provider 包。
 */
const openrouter = createOpenAI({
    baseURL: process.env.OPENROUTER_BASE_URL,
    apiKey: process.env.OPENROUTER_API_KEY,
})

/** 工具步数上限：product-spec §11 要求 stepCountIs(8)，防止无限循环 */
const MAX_STEPS = 8

/**
 * 请求体校验。
 * 用 .passthrough() 而不是 .strict()：UIMessage 的形状由 AI SDK 决定，
 * 它以后新增字段时不应该让服务端 400。
 */
const ChatRequestSchema = z
    .object({
        messages: z.array(z.unknown()).min(1),
        model: z.string().min(1).optional(),
        /** 没有 chatId 表示"尚未落库的新会话"，此时不持久化 */
        chatId: z.string().min(1).nullable().optional(),
    })
    .passthrough()

/**
 * 模型白名单：只允许 lib/model.ts 里登记的模型。
 * 直接接受任意字符串会让客户端把请求转发到任意上游模型，也让成本不可控。
 */
const MODEL_IDS = new Set(chatModels.map((m) => m.id))

function resolveModelId(requested: unknown): string {
    if (typeof requested === 'string' && MODEL_IDS.has(requested)) {
        return requested
    }
    return DEFAULT_CHAT_MODEL
}

/**
 * 保留多少条最近消息不进摘要。
 * 太小 → 模型失去近期上下文；太大 → 摘要省不下东西。
 * 6 条约等于 3 轮问答，足够覆盖"这轮在讨论什么"。
 */
const RECENT_WINDOW = 6

/**
 * 判断一条消息是否"已定稿"。
 *
 * 为什么要判：把**进行中**的工具调用摘要掉，会让模型看不到自己刚发起的调用，
 * 症状是它重复调用同一个工具或答非所问。带 `input-streaming` / `input-available`
 * 状态的工具 part 表示这次调用还没落地。
 */
const IN_FLIGHT_TOOL_STATES = new Set(['input-streaming', 'input-available'])

function isFinalized(message: UIMessage): boolean {
    const parts = message.parts ?? []
    return !parts.some((p) => {
        if (!p.type.startsWith('tool-') && p.type !== 'dynamic-tool') return false
        const state = (p as { state?: string }).state
        return state !== undefined && IN_FLIGHT_TOOL_STATES.has(state)
    })
}

/**
 * 摘要刷新的触发阈值：**未摘要内容**累计超过这个字符数才刷新。
 *
 * 为什么要有阈值：每轮都刷新会让摘要调用的次数与对话轮数成正比，
 * 成本优势被吃掉。按字符数触发才能让"多少内容换一次摘要"变得可预期。
 */
const SUMMARY_TRIGGER_CHARS = 4000

/**
 * 判断是否需要刷新摘要，需要就刷新并落库。
 *
 * 边界规则（最关键的一条）：只摘要**倒数 RECENT_WINDOW 条之前**的已定稿消息。
 * 这个"落后于最新轮次"的约束保证了进行中的工具调用永远在原文里。
 */
async function refreshSummaryIfNeeded(params: {
    chatId: string
    userId: string
    uiMessages: UIMessage[]
    requestId: string
}): Promise<void> {
    const { chatId, userId, uiMessages, requestId } = params

    const chat = await getChatById(chatId, userId)
    if (!chat) return

    // 找到摘要边界（没有摘要就从最开头算）
    const lastSummarizedIndex = chat.summaryUpToMsgId
        ? uiMessages.findIndex((m) => m.id === chat.summaryUpToMsgId)
        : -1

    // 候选 = 边界之后、且留出 RECENT_WINDOW 条不动的那一段
    const candidates = uiMessages.slice(
        lastSummarizedIndex + 1,
        Math.max(0, uiMessages.length - RECENT_WINDOW),
    )

    // 必须全部已定稿，否则这次跳过（下次再来）
    const finalized = candidates.filter(isFinalized)
    if (finalized.length !== candidates.length) return
    if (finalized.length === 0) return

    // 阈值：本批新增内容不够多就不值得调一次模型
    const newChars = flattenForLength(finalized)
    if (newChars < SUMMARY_TRIGGER_CHARS && chat.summary) return

    const result = await summarizeHistory({
        existingSummary: chat.summary,
        messages: finalized,
        model: DEFAULT_SUMMARY_MODEL,
    })

    await updateChatSummary({
        chatId,
        userId,
        summary: result.summary,
        upToMessageId: result.upToMessageId,
    })

    logEvent('info', 'chat.summaryUpdated', {
        requestId,
        chatId,
        summarizedCount: finalized.length,
        originalChars: result.originalChars,
        summaryChars: result.summaryChars,
        // 压缩比：越小越好。异常大（如 >20）说明摘要丢信息，值得看一眼
        ratio: result.originalChars > 0
            ? Number((result.summaryChars / result.originalChars).toFixed(3))
            : null,
    })
}

/** 只算文本长度，不构造完整字符串（大历史下省内存） */
function flattenForLength(messages: UIMessage[]): number {
    let total = 0
    for (const m of messages) {
        for (const p of m.parts ?? []) {
            if (p.type === 'text' && typeof (p as { text?: unknown }).text === 'string') {
                total += (p as { text: string }).text.length
            }
        }
    }
    return total
}

export const POST = withApiLogging({
    event: 'chat.POST',
    handler: async (req: Request, requestId: string) => {
        const userId = await requireUserId()

        const parsed = ChatRequestSchema.safeParse(await req.json().catch(() => null))
        if (!parsed.success) {
            return Response.json({ error: 'INVALID_BODY', requestId }, { status: 400 })
        }

        const { messages, chatId } = parsed.data
        const model = resolveModelId(parsed.data.model)
        const uiMessages = messages as UIMessage[]

        // 会话模式必须从服务端读，不能相信客户端传参：
        // mode 决定提示词严格程度，属于授权边界。
        // 新会话（还没有 chatId）用 inspector：本应用的核心用途就是代码分析，
        // 与 prisma schema 的 @default("chat") 不同是刻意的——schema 默认值面向"最小权限"，
        // 这里是"本应用的实际用途"。要改 schema 默认值需先确认历史会话的预期行为。
        //
        // ⚠️ chat 必须声明在 if 之外：后面的历史裁剪（buildModelHistory）与
        // system prompt 拼接（getSystemPromptWithSummary）都要读它的 summary 字段。
        // chatId 为空时保持 null，表示"尚未落库的新会话"——此时不持久化也不摘要。
        let mode: ChatMode = 'inspector'
        let chat: Awaited<ReturnType<typeof getChatById>> = null
        if (chatId) {
            chat = await getChatById(chatId, userId)
            if (!chat) {
                // 会话不存在或不属于当前用户——刻意不区分，避免泄漏存在性
                return Response.json({ error: 'NOT_FOUND', requestId }, { status: 404 })
            }
            // DB 里是 String，可能被写成非法值；非法则回落默认
            mode = isChatMode(chat.mode) ? chat.mode : 'inspector'
        }

        // 用户消息由服务端落库（助手消息由 onFinish 负责）。
        // 没有这一步，历史记录里会只剩助手的回答。
        // 顺带在这里处理「首条用户消息生成会话标题」。
        const lastUserMessage = [...uiMessages].reverse().find((m) => m.role === 'user')
        if (chatId && lastUserMessage) {
            const { updatedTitle } = await saveUserMessage({
                chatId,
                userId,
                message: lastUserMessage,
            })
            if (updatedTitle) {
                logEvent('info', 'chat.titleSet', { requestId, chatId, title: updatedTitle })
            }
        }

        // 裁剪历史：已被摘要覆盖的部分不再重发。
        // 注意 convertToModelMessages 传入的是**裁剪后**的数组，
        // 而 toUIMessageStreamResponse 的 originalMessages 仍用完整 uiMessages ——
        // 后者用于给响应消息分配稳定 id，与发给模型的内容无关。
        const historyForModel = buildModelHistory(chat, uiMessages)

        // 摘要注入 system prompt（见 summary.ts 里关于"为什么不插合成消息"的说明）
        const systemPrompt = getSystemPromptWithSummary(mode, chat?.summary ?? null)

        // 多步工具循环。
        // 注意 stopWhen 的默认值是 stepCountIs(1)：不显式设置的话工具只会执行一轮，
        // 模型拿不到工具结果就得作答，表现为"工具好像没接上"。
        // convertToModelMessages 是异步的（UIMessage.parts → ModelMessage[]），必须 await。
        const modelMessages = await convertToModelMessages(historyForModel)

        // 每请求一个新的工具集（含 guard）。
        // 不能复用模块级常量：guard 的计数是"单次分析"语义，共享会把不同用户的预算混在一起。
        const tools = createGuardedAgentTools()

        // 本次会话中工具真实返回过的路径，用于 onFinish 做引用交叉验证。
        // 注意作用域：必须在 streamText 之外声明，因为 onFinish 回调里要用它。
        const toolCallPaths = new Set<string>()

        const result = streamText({
            model: openrouter(model),
            system: systemPrompt,
            messages: modelMessages,
            tools,
            stopWhen: stepCountIs(MAX_STEPS),
            abortSignal: req.signal,
            onError: ({ error }) => {
                logEvent('error', 'chat.streamError', {
                    requestId,
                    model,
                    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
                })
            },
            onFinish: ({ usage, steps, finishReason }) => {
                // 收集本次实际通过工具见到过的路径，供 onFinish 做引用交叉验证。
                // 为什么在这里收：toolResults 里已经带了工具返回体，
                // 而 readFile/grep 的返回体都有 path / matches[].path 字段。
                for (const step of steps) {
                    for (const tr of step.toolResults) {
                        collectPaths(tr.output, toolCallPaths)
                    }
                }

                const readFileCount = steps.reduce(
                    (n, s) => n + s.toolCalls.filter((c) => c.toolName === 'readFile').length,
                    0,
                )
                const stepsWithText = steps.filter((s) => s.text.length > 0).length

                // 成本与工具步数观测（Day 1–2 建立的结构化日志在这里收口）。
                // readFileCount 是 Day 13–14 的核心 KPI：
                //   「完成一次代码分析要读几次文件」。基线（2026-10-06 实测）
                //   = 1 次 listDir + 7 次 readFile = 14700 prompt tokens。
                logEvent('info', 'chat.finish', {
                    requestId,
                    userId,
                    model,
                    mode,
                    finishReason,
                    promptTokens: usage.inputTokens,
                    completionTokens: usage.outputTokens,
                    steps: steps.length,
                    tools: steps.flatMap((s) => s.toolCalls.map((c) => c.toolName)),
                    readFileCount,
                    seenPathCount: toolCallPaths.size,
                    // 一步文本都没产出 = 模型只调工具就结束了。
                    // 这是"历史里出现空助手消息"的直接原因，值得单独看见。
                    stepsWithText,
                    // 摘要效果观测：sentMessageCount 远小于 uiMessageCount
                    // 说明裁剪生效；两者相等说明退化成了全量发送。
                    uiMessageCount: uiMessages.length,
                    sentMessageCount: historyForModel.length,
                    hasSummary: Boolean(chat?.summary),
                })
            },
        })

        // UI Message Stream：与前端 useChat 的协议一致。
        // sendReasoning=false 对应 product-spec §10「禁止展示模型原始推理」。
        return result.toUIMessageStreamResponse({
            // 提供 originalMessages 后进入持久化模式，响应消息会带上稳定的 messageId；
            // 没有它，onFinish 里的 responseMessage.id 不可靠，落库会拿到不稳定的主键。
            originalMessages: uiMessages,
            sendReasoning: false,
            onFinish: async ({ responseMessage, isAborted }) => {
                const text = extractTextFromParts(responseMessage.parts)

                // 异常信号：落库路径触发了、但一个字的文本都没抽到。
                // 只在真出问题时输出（正常情况下必然有文本），所以不会刷屏。
                // 判读 partTypes：
                //   只有 tool-*  → 模型只调了工具、没产出文本（改提示词，不是改代码）
                //   含 text      → text part 存在但 text 字段不是 string（抽取逻辑有问题）
                //   no-parts     → parts 结构异常（SDK 行为问题）
                if (text.length === 0 && !isAborted) {
                    logEvent('warn', 'chat.emptyAssistantContent', {
                        requestId,
                        chatId: chatId ?? null,
                        messageId: responseMessage.id || null,
                        partTypes: responseMessage.parts?.map((p) => p.type).join(',') || 'no-parts',
                        nonStringTextParts:
                            responseMessage.parts
                                ?.filter((p) => p.type === 'text' && typeof (p as { text?: unknown }).text !== 'string')
                                .length ?? 0,
                    })
                }

                // 来源引用交叉验证（product-spec §7.3「禁止编造文件路径」）。
                // 提示词只是**礼貌请求**，模型仍可能引用它从未读过的文件。
                // 这里把它变成可检测的事实：抽取输出里的 file:line，
                // 与本次工具真实返回过的路径比对，未命中的就是幻觉信号。
                // 只打日志、不做拦截 —— 误报的代价（丢弃一段有用的回答）远高于漏报。
                const unverified = unverifiedCitations(text, toolCallPaths)
                if (unverified.length > 0) {
                    logEvent('warn', 'chat.unverifiedCitations', {
                        requestId,
                        chatId: chatId ?? null,
                        count: unverified.length,
                        // 只记路径，不记引用周围的正文
                        paths: unverified.map((c) => c.path).slice(0, 10),
                    })
                }

                if (!chatId) return
                try {
                    const { content } = await upsertAssistantMessage({
                        chatId,
                        userId,
                        message: responseMessage,
                        isAborted,
                    })
                    logEvent('info', 'chat.persist', {
                        requestId,
                        chatId,
                        messageId: responseMessage.id,
                        isAborted,
                        contentLength: content.length,   // 只记长度，不记内容
                    })

                    // 异步刷新摘要：**刻意不 await**。
                    //   摘要是后台优化，让用户为它多等一次模型调用不可接受；
                    //   即使摘要失败，落库已经完成，主链路不受影响。
                    // 用 void + catch 而不是 await + try：
                    // 这个 Promise 的生命周期**超出本次响应**，若不加 catch，
                    // 它 reject 时会变成 unhandledRejection 让进程告警。
                    void refreshSummaryIfNeeded({
                        chatId,
                        userId,
                        uiMessages,
                        requestId,
                    }).catch((err) => {
                        logEvent('error', 'chat.summaryFailed', {
                            requestId,
                            chatId,
                            error: err instanceof Error ? err.message : String(err),
                        })
                    })
                } catch (err) {
                    // 落库失败不能让已经流式返回给用户的内容消失，只记日志
                    logEvent('error', 'chat.persistFailed', {
                        requestId,
                        chatId,
                        messageId: responseMessage.id,
                        error: err instanceof Error ? err.message : String(err),
                    })
                }
            },
        })
    },
})

// 摘要边界：只对「已定稿且不在最近窗口内」的消息做摘要
// RECENT_WINDOW / isFinalized 已上移到文件顶部常量区 —— 它们被 refreshSummaryIfNeeded
// 使用，放在末尾会让阅读顺序颠倒（先看到使用、再看到定义）。

/**
 * 计算本次该发给模型的 messages。
 *
 * 语义：`summaryUpToMsgId` **及其之前**的消息已被摘要替代，不重发；
 * 之后的消息**原文全发**。
 *
 * 为什么这样是安全的：摘要边界永远落后于最新轮次
 * （它是在请求**结束后**才刷新的），所以进行中的 tool-call / tool-result
 * 一定落在"之后"的那一段里，绝不会被摘要吞掉。
 *
 * 任何一处判断不成立就**退回全量原文**——宁可多花 token，也不能发一段
 * 缺了中间步骤的历史给模型（那比多花钱糟糕得多）。
 */
function buildModelHistory(
    chat: { summary: string | null; summaryUpToMsgId: string | null } | null,
    uiMessages: UIMessage[],
): UIMessage[] {
    if (!chat?.summary || !chat.summaryUpToMsgId) return uiMessages

    const cutIndex = uiMessages.findIndex((m) => m.id === chat.summaryUpToMsgId)
    if (cutIndex < 0) return uiMessages        // 边界消息已不在（被删除/换会话），退回全量

    const live = uiMessages.slice(cutIndex + 1)
    // 近期窗口太小说明对话还短，摘要省不下什么，直接全发
    if (live.length < RECENT_WINDOW) return uiMessages
    // 有待定稿的工具调用时不做裁剪
    if (!live.every(isFinalized)) return uiMessages

    return live
}
