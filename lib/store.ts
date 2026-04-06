import 'server-only'
import { Message } from "@/types/chat";
import { generateId } from "@/lib/utils";
import { readStoreSync, writeStore, PersistShape, PersistChat } from "@/lib/persist";

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

// 从内存获取
function hydrateFromPersist(data: PersistShape) {
  chats.clear()
  messages.clear()
  for (const c of data.chats) {
    // 读取并同步chats
    chats.set(c.id, {
      id: c.id,
      title: c.title,
      createdAt: new Date(c.createdAt),
      updatedAt: new Date(c.updatedAt),
      model: c.model,
    })
    for (const [id, list] of Object.entries(data.messages || {})) {
      // 读取并同步messages
      messages.set(id, list.map(m => ({
        ...m,
        createdAt: new Date(m.createdAt)
      })))
    }

    for (const c of chats.values()) {
      // 如果不存在对话消息
      if (!messages.has(c.id)) {
        messages.set(c.id, [])
      }
    }
  }
}

function serializeForPersist(): PersistShape {
  const outChats: PersistChat[] = Array.from(chats.values()).map(c => ({
    id: c.id,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    model: c.model,
  }))
  const outMessages: Record<string, Message[]> = {}
  for (const [id, list] of messages.entries()) {
    outMessages[id] = list
  }
  return {
    chats: outChats,
    messages: outMessages,
  }
}

// 启用同步加载
hydrateFromPersist(readStoreSync())

// function initialSampleData() {
//   const chat: Chat = {
//     id: generateId(),
//     title: '默认对话',
//     createdAt: new Date(),
//     updatedAt: new Date(),
//     model: 'Qwen2.5',
//   }
//   chats.set(chat.id, chat)
//   messages.set(chat.id, [
//     {
//       id: 'msg-1',
//       role: 'user',
//       content: '你好',
//       createdAt: new Date(),
//     },
//     {
//       id: 'msg-2',
//       role: 'assistant',
//       content: '你好，我是智能助手',
//       createdAt: new Date(),
//     }
//   ])
// }
// initialSampleData()

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
  messages.set(id, [])
  void writeStore(serializeForPersist())
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
  // const chat = getChatById(id)
  // if (chat) {
  //   chat.title = title
  //   chat.updatedAt = new Date()
  // }
  const chat = chats.get(id)
  if (chat) {
    chat.title = title
    chat.updatedAt = new Date()
    void writeStore(serializeForPersist())
  }
}

// 删除对话
// 删除对话的key也使用chatId，每个chatId对应一个消息列表
export function deleteChat(id: string) {
  // chats.delete(id)
  // messages.delete(id)
  chats.delete(id)
  messages.delete(id)
  void writeStore(serializeForPersist())
}

// 获取消息列表
export function getMessagesByChatId(id: string): Message[] {
  return messages.get(id) || []
}

// 添加消息
export function addMessage(chatId: string, message: Message) {
  // const messagesByChat = getMessagesByChatId(chatId)
  // messagesByChat.push(message)
  // messages.set(chatId, messagesByChat)

  // // 更新对话时间
  // const chat = getChatById(chatId)
  // if (chat) {
  //   chat.updatedAt = new Date()

  //   // 如果是第一条消息，设置标题
  //   if (message.role === 'user' && messagesByChat.filter(msg => msg.role === 'user').length === 1) {
  //     chat.title = message.content.slice(0, 10) + (message.content.length > 10 ? '...' : '')
  //   }
  // }
  const list = messages.get(chatId) || []
  list.push(message)
  messages.set(chatId, list)
  const chat = chats.get(chatId)
  if (chat) {
    chat.updatedAt = new Date()
  }
  void writeStore(serializeForPersist())
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
  void writeStore(serializeForPersist())
}