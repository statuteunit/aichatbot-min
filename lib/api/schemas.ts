// lib/api/schemas.ts（新建）
import { z } from 'zod'
import { DEFAULT_CHAT_MODEL } from '@/lib/model'

export const CreateChatSchema = z.object({
  model: z.string().min(1).default(DEFAULT_CHAT_MODEL),
}).strict()   // 传 userId 会直接 400，而不是被静默忽略

export const UpdateChatTitleSchema = z.object({ title: z.string().max(200) }).strict()

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