import { getAllChats, createChat } from '@/lib/store'
import { NextRequest } from 'next/server'

// 获取所有对话的历史记录
export async function GET(req: NextRequest) {
  const chats = getAllChats()
  return Response.json(chats)
}

// 创建新对话接口
export async function POST(req: NextRequest) {
  const { model } = await req.json()
  const chat = createChat(model)
  return Response.json(chat)
}