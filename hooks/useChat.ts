// hooks/useChat.ts
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Message, ChatCompletionMessage } from '@/types/chat'
import type { MessageStatus, StreamEvent } from '@/types/stream'
import { initialStreamState, reduceStreamEvent, type StreamState } from '@/lib/stream/uiStream'
import { createSseParser } from '@/lib/stream/sse'
import { generateId } from '@/lib/utils'
import { logEvent } from '@/lib/logging'

interface UseChatOptions {
    chatId?: string
    api?: string
    model?: string
    initialMessages?: Message[]
    onChatTitleChange?: (chatId: string, title: string) => void
}

interface UseChatReturn {
    messages: Message[]
    input: string
    /** 有任何请求在跑（流式或工具） */
    isBusy: boolean
    /** 仅文本增量阶段为 true */
    isStreaming: boolean
    status: MessageStatus
    setInput: (value: string) => void
    append: (content: string) => Promise<void>
    reload: () => Promise<void>
    stop: () => void
    setMessages: (messages: Message[]) => void
}

/** 从服务端错误响应里尽量提取可展示的信息，含 requestId */
async function describeHttpError(res: Response): Promise<string> {
    let body: unknown = null
    try {
        body = await res.json()
    } catch {
        // 响应体不是 JSON，忽略
    }
    const data = body as { error?: string; requestId?: string } | null
    const parts = [`HTTP ${res.status}`]
    if (data?.error) parts.push(data.error)
    if (data?.requestId) parts.push(`requestId=${data.requestId}`)
    return parts.join(' · ')
}

export function useChat(options: UseChatOptions = {}): UseChatReturn {
    const {
        chatId,
        api = '/api/chat',
        model = 'openrouter/free',
        initialMessages = [],
        onChatTitleChange,
    } = options

    const [input, setInput] = useState('')
    const [messages, setMessages] = useState<Message[]>(initialMessages)
    const [streamState, setStreamState] = useState<StreamState>(initialStreamState)

    const abortControllerRef = useRef<AbortController | null>(null)
    /** 是否已主动 abort，用于抑制 AbortError 被当成失败 */
    const abortedRef = useRef(false)
    /** 锁定「本次提问之前」的消息列表，避免 append 依赖 messages 导致频繁重建 */
    const lockedMessagesRef = useRef<Message[]>(messages)
    /** 高频流式更新的批量刷新 */
    const pendingStateRef = useRef<StreamState | null>(null)
    const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    useEffect(() => {
        lockedMessagesRef.current = messages
    }, [messages])

    // 卸载时清掉未触发的 flush，避免对已卸载组件 setState
    useEffect(() => {
        return () => {
            if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
            abortControllerRef.current?.abort()
        }
    }, [])

    // 切换会话时重置流状态，避免上一个会话的状态泄漏过来
    useEffect(() => {
        setStreamState(initialStreamState)
    }, [chatId])

    const cancelPendingFlush = useCallback(() => {
        if (flushTimerRef.current) {
            clearTimeout(flushTimerRef.current)
            flushTimerRef.current = null
        }
        pendingStateRef.current = null
    }, [])

    /** 节流：一个 tick 内多次 chunk 只触发一次 setState */
    const scheduleFlush = useCallback(() => {
        if (flushTimerRef.current) return
        flushTimerRef.current = setTimeout(() => {
            flushTimerRef.current = null
            if (pendingStateRef.current) setStreamState(pendingStateRef.current)
        }, 50)
    }, [])

    /** 把累积状态一次性刷进消息列表 */
    const flushToMessage = useCallback(
        (messageId: string) => {
            const final = pendingStateRef.current
            cancelPendingFlush()
            if (!final) return
            setStreamState(final)
            setMessages((prev) =>
                prev.map((m) =>
                    m.id === messageId
                        ? {
                            ...m,
                            content: final.content,
                            status: final.status,
                            tools: final.tools,
                            errorText: final.errorText,
                        }
                        : m,
                ),
            )
        },
        [cancelPendingFlush],
    )

    /** 把助手最终内容写回数据库 */
    const persistAssistant = useCallback(
        async (targetChatId: string, messageId: string, content: string, errorText?: string) => {
            try {
                await fetch(`/api/chats/${targetChatId}/messages`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    // 注意：Message 表当前没有 status/errorText 字段，所以失败信息只能
                    // 作为 content 落库（后续 product-spec §8 的 Message.parts 才能结构化保存）
                    body: JSON.stringify({
                        messageId,
                        content: errorText && !content ? `[生成失败] ${errorText}` : content,
                    }),
                })
            } catch (err) {
                logEvent('warn', 'chat.persistFailed', {
                    chatId: targetChatId,
                    messageId,
                    err: err instanceof Error ? err.message : String(err),
                })
            }
        },
        [],
    )

    const append = useCallback(
        async (content: string) => {
            const trimmed = content.trim()
            if (!trimmed) return

            const baseMessages = lockedMessagesRef.current
            const userMessage: Message = {
                id: generateId(),
                role: 'user',
                content: trimmed,
                createdAt: new Date(),
                status: 'done',
            }
            const assistantMessage: Message = {
                id: generateId(),
                role: 'assistant',
                content: '',
                createdAt: new Date(),
                status: 'streaming',
                tools: [],
            }

            setMessages([...baseMessages, userMessage, assistantMessage])
            setInput('')

            let queue: StreamState = { ...initialStreamState, status: 'streaming' }
            pendingStateRef.current = queue
            setStreamState(queue)

            const abortController = new AbortController()
            abortControllerRef.current = abortController
            abortedRef.current = false

            // 先落库：用户消息 + 助手占位
            if (chatId) {
                try {
                    const saveRes = await fetch(`/api/chats/${chatId}/messages`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userMessage, assistantMessage }),
                    })
                    if (saveRes.ok) {
                        const saveData = await saveRes.json()
                        if (saveData.updatedTitle && onChatTitleChange) {
                            onChatTitleChange(chatId, saveData.updatedTitle)
                        }
                    }
                } catch (err) {
                    logEvent('warn', 'chat.saveMessagesFailed', {
                        chatId,
                        err: err instanceof Error ? err.message : String(err),
                    })
                }
            }

            let failureText: string | null = null

            try {
                const apiMessages: ChatCompletionMessage[] = [...baseMessages, userMessage].map((m) => ({
                    role: m.role,
                    content: m.content,
                }))

                const res = await fetch(api, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model, messages: apiMessages, stream: true }),
                    signal: abortController.signal,
                })

                if (!res.ok) {
                    throw new Error(await describeHttpError(res))
                }
                if (!res.body) {
                    throw new Error('服务端未返回可读流')
                }

                const reader = res.body.getReader()
                const decoder = new TextDecoder()
                const parseSse = createSseParser()

                while (true) {
                    const { done, value } = await reader.read()
                    if (done) break

                    for (const data of parseSse(decoder.decode(value, { stream: true }))) {
                        if (data === '[DONE]') continue
                        let event: StreamEvent
                        try {
                            event = JSON.parse(data) as StreamEvent
                        } catch {
                            // 非 JSON 的 data 行，直接跳过
                            continue
                        }
                        if (!event || typeof event.type !== 'string') continue
                        queue = reduceStreamEvent(queue, event)
                        pendingStateRef.current = queue
                        scheduleFlush()
                    }
                }

                // 正常结束
                if (queue.status !== 'done') {
                    queue = reduceStreamEvent(queue, { type: 'finish' })
                }
                pendingStateRef.current = queue
                flushToMessage(assistantMessage.id)

                if (chatId) {
                    await persistAssistant(chatId, assistantMessage.id, queue.content)
                }
            } catch (err) {
                const isAbort =
                    abortedRef.current || (err instanceof Error && err.name === 'AbortError')

                if (isAbort) {
                    // 中断：保留已生成内容，状态收敛为 done
                    queue = reduceStreamEvent(queue, { type: 'abort' })
                } else {
                    failureText = err instanceof Error ? err.message : String(err)
                    queue = reduceStreamEvent(queue, { type: 'error', errorText: failureText })
                    logEvent('error', 'chat.streamFailed', {
                        chatId: chatId ?? null,
                        assistantMessageId: assistantMessage.id,
                        errorText: failureText,
                    })
                }

                pendingStateRef.current = queue
                flushToMessage(assistantMessage.id)

                if (chatId) {
                    await persistAssistant(chatId, assistantMessage.id, queue.content, failureText ?? undefined)
                }
            } finally {
                abortControllerRef.current = null
                abortedRef.current = false
            }
        },
        [api, model, chatId, onChatTitleChange, persistAssistant, scheduleFlush, flushToMessage],
    )

    const reload = useCallback(async () => {
        const lastUserIndex = messages.findLastIndex((m) => m.role === 'user')
        if (lastUserIndex === -1) return
        const lastUserMessage = messages[lastUserIndex]
        // 截断到最后一条用户消息之前，再重发（保留原语义）
        const truncated = messages.slice(0, lastUserIndex)
        lockedMessagesRef.current = truncated
        setMessages(truncated)
        await append(lastUserMessage.content)
    }, [messages, append])

    const stop = useCallback(() => {
        if (!abortControllerRef.current) return
        abortedRef.current = true
        abortControllerRef.current.abort()
    }, [])

    const status = streamState.status
    const isStreaming = status === 'streaming'
    const isBusy = status === 'streaming' || status === 'tool' || status === 'approval'

    return {
        messages,
        input,
        isBusy,
        isStreaming,
        status,
        setInput,
        append,
        reload,
        stop,
        setMessages,
    }
}