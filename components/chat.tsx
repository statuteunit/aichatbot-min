'use client'

import { useChat } from "@/hooks/useChat"
import { MessageList } from "@/components/messageList"
import { ChatInput } from "@/components/chatInput"
import { ModelSelector } from "./modelSelector"
import { Siderbar } from "./siderbar"
import { DEFAULT_CHAT_MODEL } from "@/lib/model"
import { useChatCacheStore } from '@/stores/chat-cache-store'
import { useCallback, useState, useEffect } from 'react'
import { Button } from "@/components/ui/button"
import { Message } from "@/types/chat"
import { MessageStatus } from "@/types/stream"

/** 数据库返回的原始消息：createdAt 是字符串，status 可能缺失 */
interface RawMessage {
    id: string
    role: Message['role']
    content: string
    createdAt: string | Date
    status?: MessageStatus
}

function normalizeMessages(messages: RawMessage[] | undefined | null): Message[] {
    const safeMessages = Array.isArray(messages) ? messages : []
    return safeMessages.map((item) => ({
        ...item,
        createdAt: new Date(item.createdAt),
        // 历史消息一律已完成，否则 UI 会一直显示流式动画
        status: item.status ?? 'done',
    }))
}

export function Chat() {
    // 选择模型状态
    const [selectedModelId, setSelectedModelId] = useState(DEFAULT_CHAT_MODEL)
    const [currentChatId, setCurrentChatId] = useState<string | null>(null)
    const [isOpen, setIsOpen] = useState(false)
    // 从状态库取出状态和方法
    const {
        chats,
        chatsLoaded,
        messageCache,
        setChats,
        upsertChat,
        setChatSnapshot,
        clearChatSnapshot
    } = useChatCacheStore()
    const [isLoadingOlder, setIsLoadingOlder] = useState(false)

    const currentSnapshot = currentChatId ? messageCache[currentChatId] : undefined

    const { messages, input, setInput, isBusy, append, reload, stop, setMessages } = useChat({
        model: selectedModelId,
        chatId: currentChatId ?? undefined,
        onChatTitleChange: (chatId, title) => {
            const target = chats.find((item) => item.id === chatId)
            if (!target) return

            upsertChat({
                ...target,
                title,
                updatedAt: new Date().toISOString(),
            })
        }
    })

    // 拉取所有chats
    const loadChats = useCallback(async (force = false) => {
        // 加载过了，除非强制更新否则不加载
        if (chatsLoaded && !force) return
        // 获取
        const res = await fetch(`/api/chats`)
        if (!res.ok) return
        const data = await res.json()
        setChats(Array.isArray(data) ? data : [])
    }, [chatsLoaded, setChats])

    useEffect(() => {
        void loadChats()
    }, [loadChats])

    const handleSubmit = () => {
        append(input)
    }

    const handleModelChange = (modelId: string) => {
        setSelectedModelId(modelId)
        // 保存到cookie中
        document.cookie = `selectedModel=${modelId}; path=/; max-age=31536000`
    }

    const onToggleOpen = () => {
        setIsOpen(!isOpen)
    }

    const onNewChat = async () => {
        // 中断当前对话
        stop()
        setInput('')
        setMessages([])
        const res = await fetch('/api/chats', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: selectedModelId })
        })
        if (!res.ok) return
        const chat = await res.json()
        upsertChat(chat)
        clearChatSnapshot(chat.id)
        setCurrentChatId(chat.id)
        setIsOpen(false)
    }

    const onSelectChat = async (chatId: string) => {
        try {
            // 中断当前流
            stop()
            setInput('')
            const chatSummary = chats.find((item) => item.id === chatId)
            if (chatSummary?.model) {
                setSelectedModelId(chatSummary.model)
                document.cookie = `selectedModel=${chatSummary.model}; path=/; max-age=31536000`
            }
            const cached = messageCache[chatId]
            if (cached) {
                setMessages(cached.recentMessages)
                setCurrentChatId(chatId)
                setIsOpen(false)
                // 如果有缓存就不请求
                return
            }

            const res = await fetch(`/api/chats/${chatId}/messages?limit=10`)
            if (!res.ok) return
            // 获取该id下的历史记录
            const data = await res.json()
            const pageMessages = normalizeMessages(data.messages || [])
            setMessages(pageMessages)
            setChatSnapshot(chatId, pageMessages, data.hasMore, data.nextCursor)
            setCurrentChatId(chatId)
            // if (chat.chat?.model) {
            //     setSelectedModelId(chat.chat.model)
            //     document.cookie = `selectedModel=${chat.chat.model}; path=/; max-age=31536000`
            // }
            setIsOpen(false)
        } catch (e) {
            // 预留日志上报
            console.error('Failed to select chat:', e);
        }
    }
    // 用户发新消息后，最近10条缓存要跟着更新
    useEffect(() => {
        if (!currentChatId) return
        // 流式过程中不快照，避免每帧写 Zustand；流结束后再落一次
        if (isBusy) return

        const hasMore = currentSnapshot?.hasMore ?? false
        const nextCursor = currentSnapshot?.nextCursor ?? null

        setChatSnapshot(currentChatId, messages, hasMore, nextCursor)
    }, [currentChatId, messages, isBusy, currentSnapshot?.hasMore, currentSnapshot?.nextCursor, setChatSnapshot])

    // 向上滚动加载
    const loadOlderMessages = useCallback(async () => {
        if (!currentChatId || isLoadingOlder) return
        const snapshot = useChatCacheStore.getState().messageCache[currentChatId]
        if (!snapshot.hasMore || !snapshot.nextCursor) return
        setIsLoadingOlder(true)
        try {
            const params = new URLSearchParams({
                limit: '10',
                beforeId: snapshot.nextCursor.beforeId,
                beforeCreatedAt: snapshot.nextCursor.beforeCreatedAt,
            })

            const res = await fetch(`/api/chats/${currentChatId}/messages?${params.toString()}`)
            if (!res.ok) return
            const data = await res.json()
            const olderMessages = normalizeMessages(data.messages)

            const merged = [...olderMessages, ...messages]
            setMessages(merged)
            setChatSnapshot(currentChatId, merged, data.hasMore, data.nextCursor)
        } finally {
            setIsLoadingOlder(false)
        }
    }, [currentChatId, isLoadingOlder, messages, setMessages, setChatSnapshot])

    return (
        <>
            <div className="flex justify-start gap-[250px] items-center pl-5 mb-5 fixed left-0 right-0 top-0 z-999">
                {/* 控制侧边栏 */}
                <div className="">
                    <Button onClick={onToggleOpen} className="w-fit" variant="outline">
                        +
                    </Button>
                </div>
                {/* 标题栏 */}
                <header className="p-4 border-b flex-1 max-w-4xl">
                    <h1 className="text-xl font-bold">let's chat</h1>
                    <p className="text-sm text-gray-500">Powered by Openrouter</p>
                </header>
            </div>
            <div className="flex flex-col h-screen max-w-4xl mx-auto">
                {/* 侧边栏 */}
                <Siderbar
                    isOpen={isOpen}
                    onClose={onToggleOpen}
                    onNewChat={onNewChat}
                    onSelectChat={onSelectChat}
                    currentChatId={currentChatId}
                />

                {/* 模型选择器 */}
                <ModelSelector
                    selectedModelId={selectedModelId}
                    onModelChange={handleModelChange}
                />

                {/* 消息列表 */}
                <MessageList
                    messages={messages}
                    hasMore={currentSnapshot?.hasMore}
                    isLoadingOlder={isLoadingOlder}
                    onLoadOlder={loadOlderMessages}
                    onReload={() => { void reload() }}
                />

                {/* 输入框 */}
                <ChatInput
                    input={input}
                    isLoading={isBusy}
                    onInputChange={setInput}
                    onSubmit={handleSubmit}
                    onStop={stop}
                />
            </div>
        </>
    )
}
