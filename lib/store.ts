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
export function createChat(model: string): Chat {
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

// 获取所有对话
export function getAllChats(): Chat[] {
  // 按时间戳降序
  return Array.from(chats.values()).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
}

// 获取单个对话
export function getChatById(id: string): Chat | undefined {
  return chats.get(id)
}

// 更新对话标题
export function updateChatTitle(id: string, title: string) {
  const chat = getChatById(id)
  if (chat) {
    chat.title = title
    chat.updatedAt = new Date()
  }
}

// 删除对话
// 删除对话的key也使用chatId，每个chatId对应一个消息列表
export function deleteChat(id: string) {
  chats.delete(id)
  messages.delete(id)
}

// 获取消息列表
export function getMessagesByChatId(id: string): Message[] {
  return messages.get(id) || []
}

// 添加消息
export function addMessage(chatId: string, message: Message) {
  const messagesByChat = getMessagesByChatId(chatId)
  messagesByChat.push(message)
  messages.set(chatId, messagesByChat)

  // 更新对话时间
  const chat = getChatById(chatId)
  if (chat) {
    chat.updatedAt = new Date()

    // 如果是第一条消息，设置标题
    if (message.role === 'user' && messagesByChat.filter(msg => msg.role === 'user').length === 1) {
      chat.title = message.content.slice(0, 10) + (message.content.length > 10 ? '...' : '')
    }
  }
}

// 更新消息
export function updateMessage(chatId: string, messageId: string, content: string) {
  const messages = getMessagesByChatId(chatId)
  if (messages) {
    const index = messages.findIndex(msg => msg.id === messageId)
    if (index !== -1) {
      messages[index].content = content
    }
  }
}