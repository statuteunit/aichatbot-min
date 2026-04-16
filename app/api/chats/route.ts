import { getAllChats, createChat } from '@/lib/repositories/chatRepository'
import { NextRequest } from 'next/server'
import { auth } from "@/auth"

// 获取所有对话的历史记录
export async function GET(req: NextRequest) {
  const session =await auth()
  if(!session?.user?.id){
    return new Response("Unauthorized",{
        status:401
    })
  }
  const { searchParams } = new URL(req.url)
  const userId = searchParams.get('userId') || undefined
  const chats = await getAllChats(userId)
  return Response.json(chats)
}

// 创建新对话接口
export async function POST(req: NextRequest) {
  const session =await auth()
  if(!session?.user?.id){
    return new Response("Unauthorized",{
        status:401
    })
  }
  try {
    const body = await req.json()
    const { model, userId } = body
    const chat = await createChat(model ?? 'qwen 2.5:7b', userId)
    return Response.json(chat)
  } catch (error: any) {
    console.error('POST /api/chats error:', error)
    return Response.json({ error: error.message }, { status: 500 })
  }
}