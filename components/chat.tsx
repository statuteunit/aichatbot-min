'use client'

import { useChat } from "@/hooks/useChat"
import { MessageList } from "@/components/ui/messageList"
import { ChatInput } from "@/components/ui/chatInput"
import { ModelSelector } from "./modelSelector"
import { Siderbar } from "./siderbar"
import { DEFAULT_CHAT_MODEL } from "@/lib/model"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { useSession } from "next-auth/react"

export function Chat() {
    const MOCK_USER_ID = "user1"
    const { data: session } = useSession()
    const userId = session?.user?.id ?? MOCK_USER_ID
    // 模拟当前登录用户
    // 选择模型状态
    const [selectedModelId, setSelectedModelId] = useState(DEFAULT_CHAT_MODEL)
    const [currentChatId, setCurrentChatId] = useState<string | null>(null)
    const { messages, input, setInput, isLoading, append, reload, stop, setMessages } = useChat({ model: selectedModelId, chatId: currentChatId ?? undefined })
    const [isOpen, setIsOpen] = useState(false)

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
            body: JSON.stringify({ model: selectedModelId, userId: userId })
        })
        if (!res.ok) return
        const chat = await res.json()
        setCurrentChatId(chat.id)
        setIsOpen(false)
    }

    const onSelectChat = async (chatId: string) => {
        try {
            // 中断当前流
            stop()
            setInput('')
            const res = await fetch(`/api/chats/${chatId}?userId=${userId}`)
            if (!res.ok) return
            // 获取该id下的历史记录
            const chat = await res.json()
            setMessages(chat.messages || [])
            setCurrentChatId(chatId)
            if (chat.chat?.model) {
                setSelectedModelId(chat.chat.model)
                document.cookie = `selectedModel=${chat.chat.model}; path=/; max-age=31536000`
            }
            setIsOpen(false)
        } catch (e) {

        }
    }

    return (
        <div className="flex flex-col h-screen max-w-4xl mx-auto">
            {/* 标题栏 */}
            <header className="p-4 border-b">
                <h1 className="text-xl font-bold">AI Chat</h1>
                <p className="text-sm text-gray-500">Powered by Ollama</p>
            </header>

            {/* 控制侧边栏 */}
            <div className="flex justify-end p-4">
                <Button onClick={onToggleOpen} className="w-full" variant="outline">
                    +
                </Button>
            </div>

            {/* 侧边栏 */}
            <Siderbar
                isOpen={isOpen}
                onClose={onToggleOpen}
                onNewChat={onNewChat}
                onSelectChat={onSelectChat}
                currentChatId={currentChatId}
                userId={userId ?? MOCK_USER_ID}
            />

            {/* 模型选择器 */}
            <ModelSelector
                selectedModelId={selectedModelId}
                onModelChange={handleModelChange}
            />

            {/* 消息列表 */}
            <MessageList messages={messages} isLoading={isLoading} />

            {/* 输入框 */}
            <ChatInput
                input={input}
                isLoading={isLoading}
                onInputChange={setInput}
                onSubmit={handleSubmit}
            />
        </div>
    )
}
