import { Message } from "@/types/chat";
import { generateId } from "@/lib/utils";

export interface Chat {
  id: string
  title: string
  createdAt: Date
  updatedAt: Date
  model: string
}

// 对话记录
const chats = new Map<string, Chat>()
// 对话内的历史记录
const messages = new Map<string, Message[]>()

function initialSampleData() {
  const chat: Chat = {
    id: generateId(),
    title: '默认对话',
    createdAt: new Date(),
    updatedAt: new Date(),
    model: 'Qwen2.5',
  }
  chats.set(chat.id, chat)
  messages.set(chat.id, [
    {
      id: 'msg-1',
      role: 'user',
      content: '你好',
      createdAt: new Date(),
    },
    {
      id: 'msg-2',
      role: 'assistant',
      content: '你好，我是智能助手',
      createdAt: new Date(),
    }
  ])
}
initialSampleData()

// 创建对话
function createChat(model: string): Chat {
  const id = generateId()
  const chat: Chat = {
    id,
    title: '新对话',
    createdAt: new Date(),
    updatedAt: new Date(),
    model
  }
  chats.set(id, chat)
  return chat
}