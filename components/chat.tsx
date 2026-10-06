'use client'

import { useChat } from "@/hooks/useChat"
import { MessageList } from "@/components/messageList"
import { ChatInput } from "@/components/chatInput"
import { ArtifactPanel } from "@/components/artifactPanel"
import { useArtifact } from "@/stores/useArtifact"
import { ModelSelector } from "./modelSelector"
import { ModeSelector } from "./modeSelector"
import { Siderbar } from "./siderbar"
import { DEFAULT_CHAT_MODEL } from "@/lib/model"
import type { ChatMode } from "@/lib/agent/prompt"
import { useChatCacheStore } from '@/stores/chat-cache-store'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from "@/components/ui/button"
import { rowsToUIMessages, type MessageRow } from '@/lib/chat/mappers'
import { logEvent } from '@/lib/logging'

export function Chat() {
    // 选择模型状态
    const [selectedModelId, setSelectedModelId] = useState(DEFAULT_CHAT_MODEL)
    // 会话模式。默认 inspector：本应用的核心用途是代码分析。
    // 服务端始终以数据库里的 Chat.mode 为准；这里的状态用于 UI、新建会话、以及历史会话改模式。
    const [mode, setMode] = useState<ChatMode>('inspector')
    // 会话真实生效的模式（来自数据库/创建响应），用于判断"用户是否改了模式"
    const [currentChatMode, setCurrentChatMode] = useState<ChatMode>('inspector')
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
    // Artifact 面板是否可见。面板自身是 fixed 定位、宽 500px，
    // 所以这里读同一份状态给对话区让出右侧空间。
    const artifactVisible = useArtifact((state) => state.artifact?.isVisible ?? false)

    // 窄屏时不让位：面板 500px 宽，强行为它腾空间会把对话区压到不可用
    const [isNarrow, setIsNarrow] = useState(false)
    useEffect(() => {
        const check = () => setIsNarrow(window.innerWidth < 1080)
        check()
        window.addEventListener('resize', check)
        return () => window.removeEventListener('resize', check)
    }, [])

    const currentSnapshot = currentChatId ? messageCache[currentChatId] : undefined

    // useChat 现在来自 @ai-sdk/react（方案 A）：
    // 消息形状是 UIMessage（有 parts），状态由 status 直接给出，
    // 落库由服务端 /api/chat 的 onFinish 负责——客户端不再写消息。
    const {
        messages,
        input,
        setInput,
        isBusy,
        status,
        sendMessage,
        regenerate,
        stop,
        setMessages,
        reset,
        respondToApproval,
    } = useChat({
        model: selectedModelId,
        chatId: currentChatId ?? undefined,
        mode,
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

    // 流结束后强制刷新会话列表：
    // 「首条用户消息生成标题」发生在服务端的 saveUserMessage 里，
    // 客户端只有重新拉取才能看到新标题（原来靠 onChatTitleChange 回调，现已移除）。
    const wasBusyRef = useRef(false)
    useEffect(() => {
        if (wasBusyRef.current && !isBusy) {
            void loadChats(true)
        }
        wasBusyRef.current = isBusy
    }, [isBusy, loadChats])

    const handleSubmit = () => {
        sendMessage(input)
    }

    const handleModelChange = (modelId: string) => {
        setSelectedModelId(modelId)
        // 保存到cookie中
        document.cookie = `selectedModel=${modelId}; path=/; max-age=31536000`
    }

    /**
     * 切换会话模式。
     *
     * 语义：mode 是**会话级设置**，只影响**之后**的消息。
     * 历史消息记录的是它们当时实际生效的模式，不会被重写——
     * 这一点在 ModeSelector 的提示文案里如实呈现，避免用户误解。
     *
     * 未落库的新会话（理论上不存在，onNewChat 会先建库）只改本地状态；
     * 已落库的会话同时写库，因为服务端每次请求都从库里读 mode。
     */
    const handleModeChange = async (next: ChatMode) => {
        setMode(next)
        if (!currentChatId) return

        try {
            const res = await fetch(`/api/chats/${currentChatId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: next }),
            })
            if (!res.ok) {
                // 写库失败就把 UI 退回原值，避免"界面显示已切换、服务端仍用旧模式"
                setMode(currentChatMode)
                logEvent('error', 'chat.modeChangeFailed', { chatId: currentChatId, mode: next, status: res.status })
                return
            }
            setCurrentChatMode(next)
            // 同步侧边栏缓存里的 mode，切走再切回来时不会显示旧模式
            const summary = chats.find((item) => item.id === currentChatId)
            if (summary) upsertChat({ ...summary, mode: next })
        } catch (e) {
            setMode(currentChatMode)
            logEvent('error', 'chat.modeChangeFailed', {
                chatId: currentChatId,
                mode: next,
                error: e instanceof Error ? e.message : String(e),
            })
        }
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
            // 带上 mode：服务端会把它写进 Chat.mode。
            // 之后每次对话由服务端从数据库读 mode，客户端不再参与决定。
            body: JSON.stringify({ model: selectedModelId, mode })
        })
        if (!res.ok) return
        const chat = await res.json()
        upsertChat(chat)
        clearChatSnapshot(chat.id)
        setCurrentChatId(chat.id)
        // 新会话入库时的 mode 就是用户当前选的那个；currentChatMode 用于
        // 「用户是否改过模式」的判断，必须与库里的值一致
        if (chat.mode) {
            setMode(chat.mode as ChatMode)
            setCurrentChatMode(chat.mode as ChatMode)
        }
        setIsOpen(false)
    }

    const onSelectChat = async (chatId: string) => {
        try {
            // 中断当前流
            stop()
            setInput('')
            // 显式清空上一个会话的消息，并把当前会话切过去。
            //
            // 为什么必须显式做，而不是靠 useChat 内部的 effect 比较 chatId：
            // 那个 effect 会在**加载完历史之后**才跑，把刚写入的消息一起清掉。
            // 实测日志：
            //   拉取历史成功 { convertedCount: 6 }
            //   reset effect { from: undefined, to: '<id>', messagesBeforeClear: 6 }
            //   messages changed -> 6
            //   messages changed -> 0     ← 界面空白
            // 显式调用让「先清空、再加载」的顺序确定下来，不再依赖 effect 时机。
            reset()
            setCurrentChatId(chatId)

            const chatSummary = chats.find((item) => item.id === chatId)
            if (chatSummary?.model) {
                setSelectedModelId(chatSummary.model)
                document.cookie = `selectedModel=${chatSummary.model}; path=/; max-age=31536000`
            }
            // 模式的唯一真相在数据库：切会话时跟随后端返回的值，
            // 而不是沿用上一个会话的 mode——否则 UI 显示的模式会与真实生效的不一致。
            const chatMode = (chatSummary?.mode as ChatMode | undefined) ?? 'inspector'
            setMode(chatMode)
            setCurrentChatMode(chatMode)

            const cached = messageCache[chatId]
            if (cached) {
                // 缓存本身就是 UIMessage（store 已改为存 UIMessage），直接灌回 useChat
                setMessages(cached.recentMessages)
                setIsOpen(false)
                // 如果有缓存就不请求
                return
            }

            const res = await fetch(`/api/chats/${chatId}/messages?limit=10`)
            if (!res.ok) return
            // 获取该id下的历史记录。
            // 数据库里只有 content、没有 parts，必须经 row → UIMessage 转换，
            // 否则 useChat 收到缺少 parts 的消息会渲染空白。
            const data = await res.json()
            const pageMessages = rowsToUIMessages((data.messages || []) as MessageRow[])
            setMessages(pageMessages)
            setChatSnapshot(chatId, pageMessages, Boolean(data.hasMore), data.nextCursor ?? null)
            setIsOpen(false)
        } catch (e) {
            logEvent('error', 'chat.selectFailed', {
                chatId,
                error: e instanceof Error ? e.message : String(e),
            })
        }
    }

    // 用户发新消息后，最近消息要跟着更新缓存
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
            const olderMessages = rowsToUIMessages(data.messages as MessageRow[])

            const merged = [...olderMessages, ...messages]
            setMessages(merged)
            setChatSnapshot(currentChatId, merged, Boolean(data.hasMore), data.nextCursor ?? null)
        } finally {
            setIsLoadingOlder(false)
        }
    }, [currentChatId, isLoadingOlder, messages, setMessages, setChatSnapshot])

    return (
        <>
            {/* 顶部栏。
                注意 z 层级：原来是 z-999，比 Artifact 面板（z-50）高，
                于是这条**横跨整个视口**的 fixed 栏盖住了面板顶部约 73px，
                导致面板的「复制 / 编辑 / 关闭」按钮全部点不到（点击被这条栏吃掉）。
                降到 z-40：低于面板与侧边栏（z-50），但高于侧边栏遮罩（z-30）。
                同时面板打开时给它留出右侧空间（挪的是内容，背景仍然铺满）。 */}
            <div
                className="flex justify-start gap-[250px] items-center pl-5 mb-5 fixed left-0 right-0 top-0 z-40"
                style={
                    artifactVisible && !isNarrow
                        ? { paddingRight: '500px' }
                        : undefined
                }
            >
                {/* 控制侧边栏 */}
                <div className="">
                    <Button onClick={onToggleOpen} className="w-fit" variant="outline">
                        +
                    </Button>
                </div>
                {/* 标题栏 */}
                <header className="p-4 border-b flex-1 max-w-4xl">
                    <h1 className="text-xl font-bold">let&apos;s chat</h1>
                    <p className="text-sm text-gray-500">Powered by Openrouter</p>
                </header>
            </div>
            {/* 面板可见时把对话区左移并收窄。
                用内联样式而不是 tailwind 类：`mx-auto` 与 padding 的组合会让
                居中的内容溢出，而 maxWidth + marginRight 的行为是确定的。
                窄屏（< 1080px）不做位移 —— 否则对话区会被压到没有可用宽度，
                此时面板覆盖在右侧是更合理的取舍。 */}
            <div
                className="flex flex-col h-screen max-w-4xl mx-auto transition-all duration-200"
                style={
                    artifactVisible && !isNarrow
                        ? { maxWidth: 'calc(min(56rem, 100vw - 500px))', marginRight: '500px' }
                        : undefined
                }
            >
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

                {/* 模式选择器。模式是会话级设置：改了只影响**之后**的消息，
                    历史消息不会被重写（它们记录了当时实际生效的模式） */}
                <ModeSelector
                    mode={mode}
                    onModeChange={handleModeChange}
                    hasActiveChat={currentChatId !== null}
                />

                {/* 消息列表 */}
                <MessageList
                    messages={messages}
                    status={status}
                    hasMore={currentSnapshot?.hasMore}
                    isLoadingOlder={isLoadingOlder}
                    onLoadOlder={loadOlderMessages}
                    onReload={() => { void regenerate() }}
                    onApprovalResponse={respondToApproval}
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

            {/* Artifact 面板：查看/编辑从证据链或代码块打开的片段。
                必须在 Chat 内挂载 —— 之前它只有定义、没有任何地方渲染，
                导致 showArtifact() 写进 store 后完全没有 UI 承接
                （点击证据链"没有反应"的真因）。 */}
            <ArtifactPanel />
        </>
    )
}
