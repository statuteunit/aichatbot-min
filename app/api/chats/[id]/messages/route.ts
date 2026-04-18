import { NextRequest } from 'next/server'
import { addMessages, updateAssistantMessage } from '@/lib/repositories/chatRepository'
import { auth } from '@/auth'

// 添加消息，并在首条用户消息写入时自动生成标题
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) {
    return new Response('Unauthorized', {
      status: 401,
    })
  }

  const { id } = await params
  const { userMessage, assistantMessage } = await req.json()

  await addMessages(id, userMessage, assistantMessage, session.user.id)
  return Response.json({ success: true })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user?.id) {
    return new Response('Unauthorized', {
      status: 401,
    })
  }

  const { id } = await params
  const { messageId, content } = await req.json()

  await updateAssistantMessage(id, messageId, content ?? '', session.user.id)
  return Response.json({ success: true })
}
