import 'server-only'
import { prisma } from '@/lib/db'
import { Role } from '@prisma/client'

export async function createChat(model: string, userId?: string) {
  // 如果提供了 userId，则确保该用户在 User 表中存在，以避免外键约束错误
  if (userId) {
    await prisma.user.upsert({
      where: { id: userId },
      update: {},
      create: {
        id: userId,
        email: `${userId}@example.com`, // 临时填充 email 以满足唯一性约束
        name: userId
      },
    })
  }

  return prisma.chat.create({
    data: { title: '新对话', model, userId: userId || null },
  })
}

export async function getAllChats(userId?: string) {
  return prisma.chat.findMany({
    where: { userId: userId || null },
    orderBy: { updatedAt: 'desc' },
  })
}

export async function getChatWithMessages(id: string) {
  const chat = await prisma.chat.findUnique({ where: { id } })
  const messages = await prisma.message.findMany({
    where: { chatId: id },
    orderBy: { createdAt: 'asc' },
  })
  return { chat, messages }
}

export async function addMessages(
  chatId: string,
  userMessage: { id: string; role: 'user' | 'assistant' | 'system'; content: string; createdAt: Date },
  assistantMessage: { id: string; role: 'user' | 'assistant' | 'system'; content: string; createdAt: Date }
) {
  await prisma.$transaction([
    prisma.message.create({
      data: {
        id: userMessage.id,
        chatId,
        role: userMessage.role as unknown as Role,
        content: userMessage.content,
        createdAt: userMessage.createdAt,
      },
    }),
    prisma.message.create({
      data: {
        id: assistantMessage.id,
        chatId,
        role: assistantMessage.role as unknown as Role,
        content: assistantMessage.content,
        createdAt: assistantMessage.createdAt,
      },
    }),
    prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } }),
  ])
}

export async function updateAssistantMessage(chatId: string, messageId: string, content: string) {
  await prisma.$transaction([
    prisma.message.updateMany({ where: { id: messageId, chatId }, data: { content } }),
    prisma.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } }),
  ])
}

export async function updateChatTitle(id: string, title: string, userId?: string) {
  return await prisma.chat.updateMany({
    where: {
      id,
      userId: userId || null
    },
    data: {
      title,
      updatedAt: new Date()
    }
  })
}

export async function deleteChat(id: string, userId?: string) {
  const where = {
    id,
    userId: userId || null
  }

  // 先检查对话是否存在且属于该用户
  const chat = await prisma.chat.findFirst({ where })
  if (!chat) return 0

  const res = await prisma.$transaction([
    prisma.message.deleteMany({ where: { chatId: id } }),
    prisma.chat.deleteMany({ where: { id } }), // 改为 deleteMany 配合 where 过滤
  ])
  return res[1].count
}