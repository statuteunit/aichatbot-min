// lib/chat/mappers.ts
//
// 数据库 ↔ UIMessage 的转换层。
//
// 为什么需要它：
//   数据库 Message 表只有 { id, role, content, createdAt }，没有 parts。
//   而 @ai-sdk/react 的 useChat 要求 UIMessage = { id, role, parts }。
//   不做这层转换，从数据库加载历史时 useChat 会因为缺少 parts 而渲染空白
//   避免写进去的形状和读出来的形状不一致。
//
// 文本之外还有工具过程：Message.content 只装 text part，
// 工具调用落在一对多的 ToolCallRecord 上（getChatMessagesPage 会一并取出）。
// 回放时必须把它们重新拼回 parts —— 否则刷新后工具时间线整段消失，
// 助手气泡只剩模型当时写的几个字，看起来就是"AI 消息变空了"。
import type { UIMessage } from 'ai'
import type { Role } from '@/types/chat'

/** 一条工具留痕（ToolCallRecord 的回放子集） */
export interface ToolCallRecordRow {
  id: string
  toolName: string
  /** ok | awaiting_approval | denied | error */
  status: string
  input?: unknown
  output?: string | null
}

/** 数据库返回的原始行 */
export interface MessageRow {
  id: string
  role: string
  content: string
  createdAt: string | Date
  toolCallRecords?: ToolCallRecordRow[]
}

/**
 * 留痕 status → tool part 的 state。
 *
 * awaiting_approval 映射成 approval-requested 是**只读展示**用的：
 * MessageItem 只在 part 上带 `approval.id` 时才渲染 ApprovalCard，
 * 而这里刻意不构造 approval 字段 —— 历史里的那次审批早已结束，
 * 造出卡片会让用户对着一条已完成的记录再点一次批准。
 */
const HISTORY_TOOL_STATE: Record<string, string> = {
  ok: 'output-available',
  error: 'output-error',
  denied: 'output-denied',
  awaiting_approval: 'approval-requested',
}

function toolCallRecordToPart(record: ToolCallRecordRow) {
  return {
    type: `tool-${record.toolName}`,
    toolCallId: record.id,
    state: HISTORY_TOOL_STATE[record.status] ?? 'output-available',
    ...(record.input === undefined || record.input === null ? {} : { input: record.input }),
    ...(typeof record.output === 'string' && record.output.length > 0 ? { output: record.output } : {}),
  }
}

/** 数据库行 → UIMessage（供 useChat 的 setMessages / initialMessages 使用） */
export function rowToUIMessage(row: MessageRow): UIMessage {
  const parts: unknown[] = []

  if (row.content) {
    parts.push({ type: 'text', text: row.content })
  }

  for (const record of row.toolCallRecords ?? []) {
    if (!record?.toolName) continue
    parts.push(toolCallRecordToPart(record))
  }

  return {
    id: row.id,
    role: (row.role as UIMessage['role']) ?? 'assistant',
    // 形状与 @ai-sdk/react 的 UIMessagePart 一致，但无法从数据库行反推出确切类型
    parts: parts as unknown as UIMessage['parts'],
  }
}

export function rowsToUIMessages(rows: MessageRow[] | undefined | null): UIMessage[] {
  if (!Array.isArray(rows)) return []
  return rows.map(rowToUIMessage)
}

/** UIMessage → 纯文本（用于缓存快照比较、日志长度等不需要 parts 的场景） */
export function uiMessageToText(message: {
  parts?: ReadonlyArray<{ type: string; text?: string }>
}): string {
  if (!Array.isArray(message.parts)) return ''
  return message.parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')
}

/** 仅用于展示角色的兜底转换 */
export function toRole(value: string): Role {
  return value === 'user' || value === 'system' ? value : 'assistant'
}
