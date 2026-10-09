import { addMessages, getChatMessagesPage, upsertAssistantMessage } from '@/lib/repositories/chatRepository'
import { requireUserId } from '@/lib/api/auth'
import { withApiLogging, getRequestId } from '@/lib/api/observability'
import { AddMessagesSchema, PatchMessageSchema } from '@/lib/api/schemas'

// 分页查询消息记录
export const GET = withApiLogging({
  event: 'messages.GET',
  handler: async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    // requestId 从 Request 上取，不靠位置参数（动态路由的 args 含 ctx）
    const requestId = getRequestId(req)
    const userId = await requireUserId()
    const { id } = await params

    const { searchParams } = new URL(req.url)
    const rawLimit = Number(searchParams.get('limit') || 10)
    // NaN（如 ?limit=abc）会让 Prisma 的 take 报错，这里兜住
    const limit = Math.min(Number.isFinite(rawLimit) ? rawLimit : 10, 20)

    const data = await getChatMessagesPage(id, userId, {
      limit,
      beforeId: searchParams.get('beforeId') || undefined,
      beforeCreatedAt: searchParams.get('beforeCreatedAt') || undefined,
    })

    if (!data) {
      // 不属于当前用户的会话同样走这里，避免泄漏存在性
      return Response.json({ error: 'NOT_FOUND', requestId }, { status: 404 })
    }

    return Response.json(data)
  },
})

// 添加消息，并在首条用户消息写入时自动生成标题
//
// 说明：前端迁移到 @ai-sdk/react 的 useChat 后，消息落库改由服务端
// /api/chat 的 onFinish 负责，本 handler 与下面的 PATCH 一并失去调用方。
// 它们现在被完全保留（含校验），不提前删除，以免在迁移未完成的窗口期回归。
export const POST = withApiLogging({
  event: 'messages.POST',
  handler: async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const requestId = getRequestId(req)
    const userId = await requireUserId()
    const { id } = await params

    const parsed = AddMessagesSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return Response.json({ error: 'INVALID_BODY', requestId }, { status: 400 })
    }

    const { userMessage, assistantMessage } = parsed.data
    const result = await addMessages(id, userMessage, assistantMessage, userId)
    return Response.json({ success: true, updatedTitle: result.updatedTitle, requestId })
  },
})

export const PATCH = withApiLogging({
  event: 'messages.PATCH',
  handler: async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const requestId = getRequestId(req)
    const userId = await requireUserId()
    const { id } = await params

    const parsed = PatchMessageSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return Response.json({ error: 'INVALID_BODY', requestId }, { status: 400 })
    }

    // upsert 而不是 update：记录可能还不存在（客户端不再预建占位消息）
    await upsertAssistantMessage({
      chatId: id,
      userId,
      message: { id: parsed.data.messageId },
      content: parsed.data.content,
    })
    return Response.json({ success: true, requestId })
  },
})
