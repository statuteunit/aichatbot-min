import { NextRequest } from "next/server";
import { addMessages, updateAssistantMessage } from "@/lib/repositories/chatRepository"
import { auth } from "@/auth"

// 添加消息
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session =await auth()
  if(!session?.user?.id){
    return new Response("Unauthorized",{
        status:401
    })
  }
  const { id } = await params
  const { userMessage, assistantMessage } = await req.json()
  const res = await addMessages(id, userMessage, assistantMessage)
  return Response.json({ success: true })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session =await auth()
  if(!session?.user?.id){
    return new Response("Unauthorized",{
        status:401
    })
  }
  const { id } = await params
  const { messageId, content } = await req.json()
  const res = await updateAssistantMessage(id, messageId, content ?? '')
  // 默认成功避免用户等待消息上传
  return Response.json({ success: true })
}