import {
  getChatWithMessages,
  deleteChat,
  updateChatTitle,
  updateChatMode,
} from '@/lib/repositories/chatRepository'
import { requireUserId } from '@/lib/api/auth'
import { withApiLogging, logEvent, getRequestId } from '@/lib/api/observability'
import { UpdateChatSchema } from '@/lib/api/schemas'

// 查看某个历史对话
export const GET = withApiLogging({
  event: 'chats.detail.GET',
  handler: async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    // requestId 从 Request 上取，不靠位置参数 —— 见 observability.ts 的说明。
    // 动态路由的 args 含 ctx，位置参数式传参会让 handler 拿到 ctx 对象而不是 id。
    const requestId = getRequestId(req)
    const userId = await requireUserId()
    const { id } = await params
    const data = await getChatWithMessages(id, userId)
    return Response.json({ chat: data.chat, messages: data.messages, requestId })
  },
})

// 删除对话
// 非当前用户的会话：deleteChat 的 where 带 userId，影响行数为 0，返回 { res: 0 }。
// 不返回 403 是刻意的——403 会泄漏"这个 id 存在"的信息。
export const DELETE = withApiLogging({
  event: 'chats.detail.DELETE',
  handler: async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const requestId = getRequestId(req)
    const userId = await requireUserId()
    const { id } = await params
    const res = await deleteChat(id, userId)
    return Response.json({ res, requestId })
  },
})

// 更新对话标题与/或模式
export const PATCH = withApiLogging({
  event: 'chats.detail.PATCH',
  handler: async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const requestId = getRequestId(req)
    const userId = await requireUserId()
    const { id } = await params

    // 原来读的是裸 req.json()，title 为 undefined 时会静默把标题覆盖成 '新对话'。
    // 现在两个字段各自可选、但至少给一个，非法请求直接 400。
    const parsed = UpdateChatSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return Response.json({ error: 'INVALID_BODY', requestId }, { status: 400 })
    }

    const { title, mode } = parsed.data
    let titleRes: { count: number } | null = null
    let modeRes: { count: number } | null = null

    if (title !== undefined) {
      titleRes = await updateChatTitle(id, title, userId)
    }
    if (mode !== undefined) {
      modeRes = await updateChatMode(id, mode, userId)
      // mode 变更会影响后续消息的 system prompt，属于值得留痕的操作
      logEvent('info', 'chats.modeChanged', { requestId, userId, chatId: id, mode })
    }

    return Response.json({
      // 两个结果都带上：影响行数为 0 表示会话不存在或不属于该用户
      title: titleRes,
      mode: modeRes,
      requestId,
    })
  },
})
