// lib/api/schemas.ts（新建）
import { z } from 'zod'
import { DEFAULT_CHAT_MODEL } from '@/lib/model'

export const CreateChatSchema = z.object({
  model: z.string().min(1).default(DEFAULT_CHAT_MODEL),
  mode: z.enum(['chat', 'inspector', 'coding']).default('chat'),
}).strict()   // 传 userId 会直接 400，而不是被静默忽略

export const UpdateChatTitleSchema = z.object({ title: z.string().max(200) }).strict()

/**
 * PATCH /api/chats/[id] 的请求体。
 * 标题与模式各自可选，但至少给一个——否则是一次无意义的写入。
 * 用 superRefine 而不是 .refine，便于把错误挂在请求体根上。
 */
export const UpdateChatSchema = z
  .object({
    title: z.string().max(200).optional(),
    mode: z.enum(['chat', 'inspector', 'coding']).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.title === undefined && value.mode === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'title 与 mode 至少提供一个',
      })
    }
  })

export const AddMessagesSchema = z.object({
  userMessage: z.object({
    id: z.string().min(1),
    role: z.literal('user'),
    content: z.string().min(1),
    createdAt: z.coerce.date(),
  }),
  assistantMessage: z.object({
    id: z.string().min(1),
    role: z.literal('assistant'),
    content: z.string(),
    createdAt: z.coerce.date(),
  }),
}).strict()

export const PatchMessageSchema = z.object({
  messageId: z.string().min(1),
  content: z.string(),
}).strict()

export type CreateChatInput = z.infer<typeof CreateChatSchema>
export type UpdateChatTitleInput = z.infer<typeof UpdateChatTitleSchema>
export type AddMessagesInput = z.infer<typeof AddMessagesSchema>
export type PatchMessageInput = z.infer<typeof PatchMessageSchema>

// 供后续迁移中的 [id] / [id]/messages 路由使用：
// 这些 helper 把「Zod 校验 + 统一 400 响应」收敛成一处，避免每个 handler 各写一遍。
// 注意：它们**不是**泛型 any —— 入参类型为 unknown，出参由传入的 schema 精确推断。
export function parseBody<T>(
  schema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false; error: { issues: unknown } } },
  raw: unknown,
  requestId: string,
): { ok: true; data: T } | { ok: false; response: Response } {
  const parsed = schema.safeParse(raw)
  if (parsed.success) {
    return { ok: true, data: parsed.data }
  }
  return {
    ok: false,
    response: Response.json({ error: 'INVALID_BODY', requestId }, { status: 400 }),
  }
}