import { NextRequest } from 'next/server'
import { getChatWithMessages, deleteChat, updateChatTitle } from '@/lib/repositories/chatRepository'
import { auth } from '@/auth'

// 查看某个历史对话
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) {
    return new Response('Unauthorized', {
      status: 401,
    })
  }

  const { id } = await params
  const data = await getChatWithMessages(id, session.user.id)
  return Response.json({ chat: data.chat, messages: data.messages })
}

// 删除对话
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) {
    return new Response('Unauthorized', {
      status: 401,
    })
  }

  const { id } = await params
  const res = await deleteChat(id, session.user.id)
  return Response.json({ res })
}

// 更新对话标题
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) {
    return new Response('Unauthorized', {
      status: 401,
    })
  }

  const { id } = await params
  const { title } = await req.json()
  const res = await updateChatTitle(id, title ?? '新对话', session.user.id)
  return Response.json({ res })
}
