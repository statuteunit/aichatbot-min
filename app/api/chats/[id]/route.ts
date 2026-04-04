import { NextRequest } from "next/server";
import { getChatById, getMessagesByChatId, deleteChat, updateChatTitle } from "@/lib/store";

// 点击查看某个历史记录
// 第二个参数是获取动态路由的固定写法，{params}是解构赋值，
// :{params:{id:string}}是类型定义
// 合起来是解构去除动态路由的id参数，类型为string
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const chat = getChatById(params.id)
  const messages = getMessagesByChatId(params.id)
  return Response.json({
    chat,
    messages
  })
}

// 删除对话
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  deleteChat(params.id)
  return Response.json({ success: 'true' })
}

// 更新对话标题
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const { title } = await req.json()
  updateChatTitle(params.id, title)
  return Response.json({ success: 'true' })
}
