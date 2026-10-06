import 'server-only'
import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/db'
import { Role } from '@prisma/client'
import { logEvent } from '@/lib/logging'
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

/** 判断是否该为这个会话设置标题，并返回新标题（不设置则返回 null） */
function resolveChatTitle(
  chatTitle: string,
  existingMessageCount: number,
  firstUserContent: string,
): string | null {
  const shouldSetTitle =
    existingMessageCount === 0 &&
    (!chatTitle.trim() || chatTitle === DEFAULT_CHAT_TITLE)

  return shouldSetTitle ? buildChatTitleFromMessage(firstUserContent) : null
}

/** 从 UIMessage 的 parts 里抽出纯文本（text part 顺序拼接） */
export function extractTextFromParts(
  parts: ReadonlyArray<{ type: string; text?: string }> | undefined,
): string {
  if (!Array.isArray(parts)) return ''
  return parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')
}

function sortMessagesForDisplay<T extends { createdAt: Date; role: string }>(messages: T[]) {
  return [...messages].sort((a, b) => {
    const timeDiff = a.createdAt.getTime() - b.createdAt.getTime()

    if (timeDiff !== 0) {
      return timeDiff
    }

    const roleOrder: Record<string, number> = {
      system: 0,
      user: 1,
      assistant: 2,
    }

    return (roleOrder[a.role] ?? 99) - (roleOrder[b.role] ?? 99)
  })
}

export async function createChat(model: string, userId: string, mode = 'chat') {
  return prisma.chat.create({
    data: { title: DEFAULT_CHAT_TITLE, model, mode, userId },
  })
}

/**
 * 按 id 读取会话，**校验归属**。
 * 返回 null 表示会话不存在、或不属于该用户——两者刻意不区分，避免泄漏存在性。
 *
 * 用途：/api/chat 需要 chat.mode 决定 system prompt。
 * mode 是会话属性且决定提示词严格程度，属于授权边界，
 * 必须从服务端读，不能相信客户端传参（同 Day 1–2 消灭 userId 传参的理由）。
 */
export async function getChatById(
  id: string,
  userId: string,
): Promise<{ id: string; mode: string; model: string; title: string } | null> {
  return prisma.chat.findFirst({
    where: { id, userId },
    select: { id: true, mode: true, model: true, title: true },
  })
}

export async function getAllChats(userId: string) {
  return prisma.chat.findMany({
    where: { userId: userId },
    orderBy: { updatedAt: 'desc' },
  })
}

export async function getChatWithMessages(id: string, userId: string) {
  const chat = await prisma.chat.findFirst({
    where: { id, userId: userId },
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
  userId: string
) {
  return await prisma.$transaction(async (tx) => {
    const chat = await tx.chat.findFirst({
      where: { id: chatId, userId: userId },
      select: { id: true, title: true },
    })

    if (!chat) {
      throw new Error('Chat not found')
    }

    const existingMessageCount = await tx.message.count({
      where: { chatId },
    })

    // 标题推导收敛到 resolveChatTitle，与 saveUserMessage 共用同一套规则，
    // 避免两处逻辑各自演进后出现「新建会话走一条规则、发首条消息走另一条」的漂移
    const updatedTitle = resolveChatTitle(chat.title, existingMessageCount, userMessage.content)

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
        ...(updatedTitle ? { title: updatedTitle } : {}),
      },
    })

    return { updatedTitle }
  })
}

export async function upsertAssistantMessage(params: {
  chatId: string
  userId: string
  message: { id: string; parts?: ReadonlyArray<{ type: string; text?: string }> }
  isAborted?: boolean
  /**
   * 纯文本内容。两条路径共用本函数：
   *   - 新路径（服务端 onFinish）：不传，内容从 message.parts 抽取；
   *   - 旧路径（客户端 PATCH，前端迁移到 useChat 前仍在用）：只传 content，没有 parts。
   * 前端迁移完成后可以删掉这个参数与对应调用。
   */
  content?: string
}): Promise<{ content: string }> {
  const { chatId, userId, message, isAborted = false } = params
  // parts 优先；没有 parts 时回落到显式 content（旧路径）
  const content = params.content ?? extractTextFromParts(message.parts)

  // ── id 兜底 ──────────────────────────────────────────────────────────
  // 为什么必须有：SDK 可能给出**空字符串** id（实测日志 messageIdLength:0）。
  // 空串满足 TEXT NOT NULL、也满足主键唯一性，于是 upsert 从第二次起
  // 永远命中同一行、在 update 分支里**覆盖上一条 AI 消息**，
  // 表现为"AI 消息经常丢失"。
  //
  // 这里兜一个 uuid：即使客户端仍给空 id，每条消息也会落到独立主键上。
  // 调用方仍会在日志里看到 fallbackUsed 标记，便于判断 SDK 侧是否修好。
  const requestedId = typeof message.id === 'string' ? message.id.trim() : ''
  const messageId = requestedId.length > 0 ? requestedId : randomUUID()
  const fallbackUsed = requestedId.length === 0
  // ────────────────────────────────────────────────────────────────────

  // ── 诊断日志（落库决策）──────────────────────────────────────────────
  // 区分三种"看起来都是没消息"的情况：
  //   ① willSkip=true   → 中止且无文本，刻意不写（设计如此，不是 bug）
  //   ② 继续往下且 content 为空 → 写了一行空记录（历史里会是空白气泡）
  //   ③ 根本没进这个函数 → onFinish 没跑（看 diag.chat.start / onFinish 配对）
  logEvent('info', 'diag.persist.upsert', {
    chatId,
    messageId,
    requestedMessageIdType: typeof message.id,
    requestedMessageIdLength: typeof message.id === 'string' ? message.id.length : null,
    fallbackUsed,
    contentLength: content.length,
    isAborted,
    role: 'assistant',
  })

  if (!content) {
    logEvent('warn', 'diag.persist.emptyContent', {
      chatId,
      messageId,
      isAborted,
      willSkip: isAborted,
      hasParts: Array.isArray(message.parts),
      partTypes: message.parts?.map((p) => p.type).join(',') || 'no-parts',
      contentParamProvided: params.content !== undefined,
    })
  }
  // ────────────────────────────────────────────────────────────────────

  // 中止且无任何文本（用户刚发就停）：不要写入空白记录。
  // 这一步放在事务外，省一次数据库往返（所有权校验在事务内仍然保留）。
  if (!content && isAborted) {
    return { content: '' }
  }

  return prisma.$transaction(async (tx) => {
    // 所有权校验：不属于该用户的会话一律拒绝
    const chat = await tx.chat.findFirst({
      where: { id: chatId, userId },
      select: { id: true },
    })
    if (!chat) {
      throw new Error('Chat not found')
    }

    await tx.message.upsert({
      // 用兜底后的 messageId，不能用 message.id ——
      // 后者可能是空字符串，会让所有 AI 消息挤在同一个主键上互相覆盖
      where: { id: messageId },
      update: { content },
      create: {
        id: messageId,
        chatId,
        role: Role.assistant,
        content,
      },
    })

    await tx.chat.update({
      where: { id: chatId },
      data: { updatedAt: new Date() },
    })

    return { content }
  })
}

export async function saveUserMessage(params: {
  chatId: string
  userId: string
  message: { id: string; parts?: ReadonlyArray<{ type: string; text?: string }> }
}): Promise<{ updatedTitle: string | null }> {
  const { chatId, userId, message } = params
  const content = extractTextFromParts(message.parts)

  return prisma.$transaction(async (tx) => {
    const chat = await tx.chat.findFirst({
      where: { id: chatId, userId },
      select: { id: true, title: true },
    })
    if (!chat) {
      throw new Error('Chat not found')
    }

    const existingMessageCount = await tx.message.count({ where: { chatId } })
    const updatedTitle = resolveChatTitle(chat.title, existingMessageCount, content)

    // upsert 保证重试/重复请求幂等
    await tx.message.upsert({
      where: { id: message.id },
      update: { content },
      create: { id: message.id, chatId, role: Role.user, content },
    })

    await tx.chat.update({
      where: { id: chatId },
      data: {
        updatedAt: new Date(),
        ...(updatedTitle ? { title: updatedTitle } : {}),
      },
    })

    return { updatedTitle }
  })
}

export async function updateChatTitle(id: string, title: string, userId: string) {
  return await prisma.chat.updateMany({
    where: {
      id,
      userId: userId,
    },
    data: {
      title: title?.trim() || DEFAULT_CHAT_TITLE,
      updatedAt: new Date(),
    },
  })
}

/**
 * 更新会话模式。
 *
 * 语义（product-spec §10 / §14 Q5）：mode 是**会话级设置**，
 * 它决定后续消息用哪套 system prompt。允许中途更改，
 * 但只有**之后**的消息受新模式影响 —— 已产生的历史消息不会被重写，
 * 它们记录了当时实际生效的模式。这一点必须在 UI 上如实告知用户，
 * 否则用户会以为"改了模式，之前的回答也变了"。
 *
 * 注意 mode 不可由客户端任意指定：调用方（PATCH handler）已用
 * UpdateChatSchema 把它限定为 chat | inspector | coding 三个值。
 */
export async function updateChatMode(id: string, mode: string, userId: string) {
  return await prisma.chat.updateMany({
    where: {
      id,
      userId: userId,
    },
    data: {
      mode,
      updatedAt: new Date(),
    },
  })
}

export async function deleteChat(id: string, userId: string) {
  const where = {
    id,
    userId: userId,
  }

  const chat = await prisma.chat.findFirst({ where })
  if (!chat) return 0

  const res = await prisma.$transaction([
    prisma.message.deleteMany({ where: { chatId: id } }),
    prisma.chat.deleteMany({ where: { id, userId } }),
  ])

  return res[1].count
}

// 分页请求messages
export async function getChatMessagesPage(
  chatId: string,
  userId: string,
  options: {
    limit?: number
    beforeId?: string
    beforeCreatedAt?: string
  }
) {
  const { limit = 10, beforeId, beforeCreatedAt } = options
  const chat = await prisma.chat.findFirst({
    where: {
      id: chatId,
      userId: userId,
    },
    select: { id: true },
  })
  if (!chat) {
    return null
  }

  const cursorDate = beforeCreatedAt ? new Date(beforeCreatedAt) : null
  const rows = await prisma.message.findMany({
    where: {
      chatId,
      ...(beforeId && cursorDate ? {
        OR: [
          { createdAt: { lt: cursorDate } },
          {
            createdAt: cursorDate,
            id: { lt: beforeId }
          },
        ],
      } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    // 倒序返回，需要翻转
    take: limit + 1,
    // 判断是否还有下一页
  })

  const hasMore = rows.length > limit
  const pageRows = rows.slice(0, limit)
  const orderedRows = sortMessagesForDisplay(pageRows)
  // 翻转，最老的消息在最前面
  const oldest = orderedRows[0]

  return {
    messages: orderedRows,
    hasMore,
    nextCursor: hasMore && oldest ? {
      beforeId: oldest.id,
      beforeCreatedAt: oldest.createdAt.toISOString(),
    } : null,
  }
}