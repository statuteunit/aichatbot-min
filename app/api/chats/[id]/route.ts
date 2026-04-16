import { NextRequest } from 'next/server'
import { getChatWithMessages, deleteChat, updateChatTitle } from '@/lib/repositories/chatRepository'
import { auth } from "@/auth"

// 点击查看某个历史记录
// 第二个参数是获取动态路由的固定写法，{params}是解构赋值，
// :{params:{id:string}}是类型定义
// 合起来是解构去除动态路由的id参数，类型为string
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session =await auth()
  if(!session?.user?.id){
    return new Response("Unauthorized",{
        status:401
    })
  }
  const { id } = await params
  const data = await getChatWithMessages(id)
  return Response.json({ chat: data.chat, messages: data.messages })
}

// 删除对话
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session =await auth()
  if(!session?.user?.id){
    return new Response("Unauthorized",{
        status:401
    })
  }
  const { id } = await params
  const res = await deleteChat(id)
  return Response.json({ res })
}

// 更新对话标题
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session =await auth()
  if(!session?.user?.id){
    return new Response("Unauthorized",{
        status:401
    })
  }
  const { id } = await params
  const { title } = await req.json()
  const res = await updateChatTitle(id, title ?? '新对话')
  return Response.json({ res })
}
