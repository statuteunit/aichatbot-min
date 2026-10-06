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
// 注意：数据库只存最终文本，不存 tool/reasoning parts。
// 所以历史消息里的工具过程无法回放——这是刻意的（product-spec §8 的 Message.parts
// 落库属于后续阶段）。渲染历史时看不到工具时间线是预期行为。
import type { UIMessage } from 'ai'
import type { Role } from '@/types/chat'

/** 数据库返回的原始行 */
export interface MessageRow {
  id: string
  role: string
  content: string
  createdAt: string | Date
}

/** 数据库行 → UIMessage（供 useChat 的 setMessages / initialMessages 使用） */
export function rowToUIMessage(row: MessageRow): UIMessage {
  return {
    id: row.id,
    role: (row.role as UIMessage['role']) ?? 'assistant',
    parts: [{ type: 'text', text: row.content }],
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
