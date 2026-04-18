import 'server-only'
import { prisma } from '@/lib/db'
import { Role } from '@prisma/client'

const DEFAULT_CHAT_TITLE = '新对话'
const CHAT_TITLE_MAX_LENGTH = 20

function buildChatTitleFromMessage(content: string) {
  const normalized = content.replace(/\s+/g, ' ').trim()

  if (!normalized) {
    return DEFAULT_CHAT_TITLE
  }

  if (normalized.length <= CHAT_TITLE_MAX_LENGTH) {
    return normalized
  }

  return `${normalized.slice(0, CHAT_TITLE_MAX_LENGTH)}...`
}

export async function createChat(model: string, userId?: string) {
  // 如果提供了 userId，则确保该用户在 User 表中存在，以避免外键约束错误
  if (userId) {
    await prisma.user.upsert({
      where: { id: userId },
      update: {},
      create: {
        id: userId,
        email: `${userId}@example.com`,
        name: userId,
      },
    })
  }

  return prisma.chat.create({
    data: { title: DEFAULT_CHAT_TITLE, model, userId: userId || null },
  })
}

export async function getAllChats(userId?: string) {
  return prisma.chat.findMany({
    where: { userId: userId || null },
    orderBy: { updatedAt: 'desc' },
  })
}

export async function getChatWithMessages(id: string, userId?: string) {
  const chat = await prisma.chat.findFirst({
    where: { id, userId: userId || null },
  })

  if (!chat) {
    return { chat: null, messages: [] }
  }

  const messages = await prisma.message.findMany({
    where: { chatId: id },
    orderBy: { createdAt: 'asc' },
  })

  return { chat, messages }
}

export async function addMessages(
  chatId: string,
  userMessage: { id: string; role: 'user' | 'assistant' | 'system'; content: string; createdAt: Date },
  assistantMessage: { id: string; role: 'user' | 'assistant' | 'system'; content: string; createdAt: Date },
  userId?: string
) {
  await prisma.$transaction(async (tx) => {
    const chat = await tx.chat.findFirst({
      where: { id: chatId, userId: userId || null },
      select: { id: true, title: true },
    })

    if (!chat) {
      throw new Error('Chat not found')
    }

    const existingMessageCount = await tx.message.count({
      where: { chatId },
    })

    const shouldSetTitle =
      existingMessageCount === 0 &&
      (!chat.title.trim() || chat.title === DEFAULT_CHAT_TITLE)

    await tx.message.create({
      data: {
        id: userMessage.id,
        chatId,
        role: userMessage.role as unknown as Role,
        content: userMessage.content,
        createdAt: userMessage.createdAt,
      },
    })

    await tx.message.create({
      data: {
        id: assistantMessage.id,
        chatId,
        role: assistantMessage.role as unknown as Role,
        content: assistantMessage.content,
        createdAt: assistantMessage.createdAt,
      },
    })

    await tx.chat.update({
      where: { id: chatId },
      data: {
        updatedAt: new Date(),
        ...(shouldSetTitle ? { title: buildChatTitleFromMessage(userMessage.content) } : {}),
      },
    })
  })
}

export async function updateAssistantMessage(
  chatId: string,
  messageId: string,
  content: string,
  userId?: string
) {
  await prisma.$transaction(async (tx) => {
    const chat = await tx.chat.findFirst({
      where: { id: chatId, userId: userId || null },
      select: { id: true },
    })

    if (!chat) {
      throw new Error('Chat not found')
    }

    await tx.message.updateMany({
      where: { id: messageId, chatId },
      data: { content },
    })

    await tx.chat.update({
      where: { id: chatId },
      data: { updatedAt: new Date() },
    })
  })
}

export async function updateChatTitle(id: string, title: string, userId?: string) {
  return await prisma.chat.updateMany({
    where: {
      id,
      userId: userId || null,
    },
    data: {
      title: title?.trim() || DEFAULT_CHAT_TITLE,
      updatedAt: new Date(),
    },
  })
}

export async function deleteChat(id: string, userId?: string) {
  const where = {
    id,
    userId: userId || null,
  }

  const chat = await prisma.chat.findFirst({ where })
  if (!chat) return 0

  const res = await prisma.$transaction([
    prisma.message.deleteMany({ where: { chatId: id } }),
    prisma.chat.deleteMany({ where: { id, userId: userId || null } }),
  ])

  return res[1].count
}
