import { getAllChats, createChat } from '@/lib/repositories/chatRepository'
import { requireUserId } from '@/lib/api/auth'
import { CreateChatSchema } from '@/lib/api/schemas'
import { DEFAULT_CHAT_MODEL } from '@/lib/model'
import { withApiLogging, logEvent } from '@/lib/api/observability'

// 获取所有对话的历史记录
export const GET = withApiLogging(async (req, requestId) => {
  const userId = await requireUserId()
  logEvent('info', 'chats.list', { requestId, userId })   // 注意：只记 id，不记内容
  const chats = await getAllChats(userId)
  return Response.json(chats)
}, 'chats.GET')

// 创建新对话接口
export const POST = withApiLogging(async (req, requestId) => {
  const userId = await requireUserId()

  const parsed = CreateChatSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return Response.json(
      { error: 'INVALID_BODY', requestId },
      { status: 400 },
    )
  }

  const chat = await createChat(parsed.data.model ?? DEFAULT_CHAT_MODEL, userId)
  logEvent('info', 'chats.create', { requestId, userId, chatId: chat.id, model: chat.model })
  return Response.json(chat)
}, 'chats.POST')

