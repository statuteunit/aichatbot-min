import { getAllChats, createChat } from '@/lib/repositories/chatRepository'
import { requireUserId } from '@/lib/api/auth'
import { CreateChatSchema } from '@/lib/api/schemas'
import { DEFAULT_CHAT_MODEL } from '@/lib/model'
import { withApiLogging, logEvent, getRequestId } from '@/lib/api/observability'

// 获取所有对话的历史记录
export const GET = withApiLogging({
  event: 'chats.GET',
  handler: async (req: Request) => {
    const requestId = getRequestId(req)
    const userId = await requireUserId()
    logEvent('info', 'chats.list', { requestId, userId })   // 注意：只记 id，不记内容
    const chats = await getAllChats(userId)
    return Response.json(chats)
  },
})

// 创建新对话接口
export const POST = withApiLogging({
  event: 'chats.POST',
  handler: async (req: Request) => {
    const requestId = getRequestId(req)
    const userId = await requireUserId()

    const parsed = CreateChatSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return Response.json({ error: 'INVALID_BODY', requestId }, { status: 400 })
    }

    // mode 来自 CreateChatSchema（含 .default('chat')），所以旧客户端不传也不会报错。
    // 之前这里漏传 mode，导致无论请求什么，落库永远是 schema 默认值——mode 是个死字段。
    const chat = await createChat(
      parsed.data.model ?? DEFAULT_CHAT_MODEL,
      userId,
      parsed.data.mode,
    )
    logEvent('info', 'chats.create', {
      requestId,
      userId,
      chatId: chat.id,
      model: chat.model,
      mode: chat.mode,
    })
    return Response.json(chat)
  },
})

