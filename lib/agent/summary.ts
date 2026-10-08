import { generateText, Output, type UIMessage } from 'ai'
import { z } from 'zod'
import { createOpenAI } from '@ai-sdk/openai'
import { getSystemPrompt, type ChatMode } from './prompt'

export interface SummarizeParams {
  existingSummary: string | null
  /** 需要被纳入摘要的消息（已定稿、不在进行中的轮次里） */
  messages: UIMessage[]
  model: string
  signal?: AbortSignal
}

export interface SummarizeResult {
  summary: string
  /** 摘要覆盖到哪条消息为止 */
  upToMessageId: string
  /** 压缩比，用于观测 */
  originalChars: number
  summaryChars: number
}

/**
 * 摘要专用 provider。
 *
 * 为什么不复用 route.ts 里的实例：那个实例是 chat 链路私有的，
 * 跨文件引用会让 summary 的可用性依赖 route 的加载——而 summary 要被
 * 后台任务调用。各自建一个的代价只是一个轻量对象。
 */
const openrouter = createOpenAI({
  baseURL: process.env.OPENROUTER_BASE_URL,
  apiKey: process.env.OPENROUTER_API_KEY,
})

export const DEFAULT_SUMMARY_MODEL = process.env.SUMMARY_MODEL ?? 'openai/gpt-oss-120b:free'

/** 摘要的硬上限：防止摘要本身无限增长，把省下来的上下文又吃回去 */
export const SUMMARY_MAX_CHARS = 4000

const SummarySchema = z.object({
  summary: z.string().min(1).max(SUMMARY_MAX_CHARS).meta({
    description:
      '压缩后的对话上下文。' +
      '必须保留：① 已确认的事实及其 `文件路径:行号` 证据；② 用户做出的决策与偏好；' +
      '③ 尚未解决的问题；④ 用户明确否定过的方向（避免重复提议）。' +
      '应当丢弃：寒暄、重复的解释、被推翻的中间推理过程。' +
      '若旧摘要与新消息冲突，以**新消息**为准，并在摘要里说明这一变化。',
  }),
})

/** 把消息拍平成纯文本，供摘要模型阅读 */
function flattenMessages(messages: UIMessage[]): string {
  return messages
    .map((m) => {
      const text = (m.parts ?? [])
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('')
      if (!text.trim()) return null
      const who = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '系统'
      return `【${who}】${text}`
    })
    .filter((v): v is string => v !== null)
    .join('\n\n')
}

export function buildSummaryPrompt(
  existingSummary: string | null,
  messages: UIMessage[],
): string {
  const conversation = flattenMessages(messages)
  return `你在维护一份**对话摘要**，用于在后续轮次中替代原始历史，节省上下文。
${existingSummary
      ? `# 已有摘要（覆盖更早的对话）
${existingSummary}
请把「已有摘要」与下面的「新增对话」合并成一份**新摘要**。不要简单拼接，
要真正合并去重：同一个事实只保留一条，被新信息推翻的旧信息要删除。`
      : '# 还没有摘要\n这是第一次生成，请只基于下面的对话内容。'}

# 新增对话
${conversation || '(没有可提取的文本内容)'}

# 输出要求
- 用中文，条目式，控制在 ${SUMMARY_MAX_CHARS} 字以内。
- 保留具体路径与行号（格式为 路径:行号，例如 lib/agent/prompt.ts:27），它们是最有价值的信息。
- 不要写"用户询问了…"这类无信息量的转述，直接写结论本身。`
}

/**
 * 把「已有摘要 + 新增消息」压缩成一份新摘要。
 *
 * 为什么是递进式（增量）摘要而不是每次全部重摘：
 *   全部重摘的话，摘要本身的输入会随对话增长而增长，成本回到原样。
 *   递进式让每次摘要的输入是「旧摘要 + 本批新增」，体量与对话长度**解耦**。
 */
export async function summarizeHistory(params: SummarizeParams): Promise<SummarizeResult> {
  const { existingSummary, messages, model, signal } = params

  if (messages.length === 0) {
    throw new Error('summarizeHistory: messages 为空，不应调用')
  }

  const originalChars =
    (existingSummary?.length ?? 0) + flattenMessages(messages).length

  const { output } = await generateText({
    model: openrouter(model),
    output: Output.object({ schema: SummarySchema }),
    prompt: buildSummaryPrompt(existingSummary, messages),
    abortSignal: signal,
  })

  if (!output?.summary) {
    // Output.object 失败时 output 可能是 undefined —— 抛错让调用方保持旧摘要
    throw new Error('summarizeHistory: 模型未返回可解析的摘要')
  }

  const summary = output.summary.slice(0, SUMMARY_MAX_CHARS)

  return {
    summary,
    // 边界是**本批消息的最后一条**：这条及之前的都已被摘要覆盖
    upToMessageId: messages[messages.length - 1].id,
    originalChars,
    summaryChars: summary.length,
  }
}

/**
 * 把摘要拼进 system prompt。
 *
 * 为什么用 system prompt 而不是插入一条 `role: 'system'` 的合成消息：
 *   AI SDK 的类型文档明确写着 "System messages should be avoided
 *   (set the system prompt on the server instead)"（见 ai/dist/index.d.ts:1606）。
 *   插合成消息还会干扰 `originalMessages` 与工具调用序列的对应关系。
 */
export function getSystemPromptWithSummary(
  mode: ChatMode | string | null | undefined,
  summary: string | null,
): string {
  const base = getSystemPrompt(mode)
  if (!summary) return base

  return `${base}

# 早期对话摘要（已压缩，替代原始历史）
以下是本次会话**较早轮次**的压缩记录。更晚的内容在下面的消息里以原文给出。
如果摘要与后续原文冲突，**以原文为准**。

${summary}`
}