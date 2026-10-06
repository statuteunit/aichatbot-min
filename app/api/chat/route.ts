import 'server-only'
import { streamText, convertToModelMessages, stepCountIs, type UIMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'
import { requireUserId } from '@/lib/api/auth'
import { withApiLogging, logEvent } from '@/lib/api/observability'
import { createGuardedAgentTools } from '@/lib/agent/tools'
import { getSystemPrompt, isChatMode, type ChatMode } from '@/lib/agent/prompt'
import {
    getChatById,
    saveUserMessage,
    upsertAssistantMessage,
    extractTextFromParts,
} from '@/lib/repositories/chatRepository'
import { chatModels, DEFAULT_CHAT_MODEL } from '@/lib/model'

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

        // ── 诊断日志（起点）──────────────────────────────────────────────
        // 与 diag.chat.onFinish 配对使用：
        //   有 START 无 FINISH → 流被中断（用户停止 / 刷新 / 断网 / 服务端重启）
        //                        → 助手记录从未落库，这是"消息丢失"的主因
        //   有 START 有 FINISH → 落库确实执行了，问题在内容为空（见 FINISH 日志）
        logEvent('info', 'diag.chat.start', {
            requestId,
            chatId: chatId ?? null,
            model,
            uiMessageCount: uiMessages.length,
            roles: uiMessages.map((m) => m.role).join(','),
            lastUserMessageId: [...uiMessages].reverse().find((m) => m.role === 'user')?.id ?? null,
        })
        // ────────────────────────────────────────────────────────────────

        // 会话模式必须从服务端读，不能相信客户端传参：
        // mode 决定提示词严格程度，属于授权边界，与 Day 1–2 处理 userId 的原则一致。
        // 新会话（还没有 chatId）用 inspector：本应用的核心用途就是代码分析，
        // 与 prisma schema 的 @default("chat") 不同是刻意的——schema 默认值面向"最小权限"，
        // 这里是"本应用的实际用途"。要改 schema 默认值需先确认历史会话的预期行为。
        let mode: ChatMode = 'inspector'
        if (chatId) {
            const chat = await getChatById(chatId, userId)
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

        // 多步工具循环。
        // 注意 stopWhen 的默认值是 stepCountIs(1)：不显式设置的话工具只会执行一轮，
        // 模型拿不到工具结果就得作答，表现为"工具好像没接上"。
        // convertToModelMessages 是异步的（UIMessage.parts → ModelMessage[]），必须 await。
        const modelMessages = await convertToModelMessages(uiMessages)

        // 每请求一个新的工具集（含 guard）。
        // 不能复用模块级常量：guard 的计数是"单次分析"语义，共享会把不同用户的预算混在一起。
        const tools = createGuardedAgentTools()

        const result = streamText({
            model: openrouter(model),
            system: getSystemPrompt(mode),
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
                // ── 诊断日志（流结束）──────────────────────────────────────
                // 与 diag.chat.onFinish 区分：这是**模型侧**流结束，
                // 而 diag.chat.onFinish 是**UI Message Stream 侧**结束。
                // 若只看到这一条、没有 diag.chat.onFinish，说明
                // 模型出完了但 UI 流的 onFinish 没触发（罕见的 SDK 行为）。
                logEvent('info', 'diag.chat.streamFinish', {
                    requestId,
                    chatId: chatId ?? null,
                    finishReason,
                    stepCount: steps.length,
                    completedSteps: steps.filter((s) => s.finishReason !== 'tool-calls').length,
                    totalToolCalls: steps.reduce((n, s) => n + s.toolCalls.length, 0),
                    // 有没有任何一步产出过文本？这是"只调工具不产出文本"的直接证据
                    stepsWithText: steps.filter((s) =>
                        s.text.length > 0,
                    ).length,
                })
                // ──────────────────────────────────────────────────────────
                // 成本与工具步数观测（Day 1–2 建立的结构化日志在这里收口）
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
                // ── 诊断日志（定位"AI 消息丢失"）────────────────────────────
                // 这条日志是整个排查的核心：它记录 onFinish **是否触发**、
                // 抽出的文本长度、以及 parts 的真实结构。
                // 判读方式：
                //   没有这条日志            → onFinish 根本没跑（流中断/abort）→ 记录没落库
                //   contentLength=0 且
                //     partTypes 里只有 tool-* → 模型只调了工具、没产出文本
                //     partTypes 含 text       → text part 存在但 text 字段不是 string
                //     partTypes 为空/no-parts → parts 结构异常
                logEvent('info', 'diag.chat.onFinish', {
                    requestId,
                    chatId: chatId ?? null,
                    messageId: responseMessage.id,
                    isAborted,
                    contentLength: extractTextFromParts(responseMessage.parts).length,
                    partTypes: responseMessage.parts?.map((p) => p.type).join(',') || 'no-parts',
                    partCount: responseMessage.parts?.length ?? 0,
                    // 只记"哪些 part 的 text 不是 string"，不记内容
                    nonStringTextParts:
                        responseMessage.parts
                            ?.filter((p) => p.type === 'text' && typeof (p as { text?: unknown }).text !== 'string')
                            .length ?? 0,
                })
                // ──────────────────────────────────────────────────────────

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
