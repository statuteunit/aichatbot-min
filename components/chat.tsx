'use client'

import { useChat } from "@/hooks/useChat"
import { MessageList } from "@/components/ui/messageList"
import { ChatInput } from "@/components/ui/chatInput"
import { ModelSelector } from "./modelSelector"
import { Siderbar } from "./siderbar"
import { DEFAULT_CHAT_MODEL } from "@/lib/model"
import { useState } from "react"
import { Button } from "@/components/ui/button"

export function Chat() {
    // 选择模型状态
    const [selectedModelId, setSelectedModelId] = useState(DEFAULT_CHAT_MODEL)
    const { messages, input, setInput, isLoading, append, reload, stop } = useChat({ model: selectedModelId })
    const [isOpen, setIsOpen] = useState(false)
    const [currentChatId, setCurrentChatId] = useState<string | null>(null)

    const handleSubmit = () => {
        append(input)
    }

    const handleModelChange = (modelId: string) => {
        setSelectedModelId(modelId)
        // 保存到cookie中
        document.cookie = `selectedModel=${modelId}; path=/; max-age=31536000`
    }

    const onClose = () => {
        setIsOpen(false)
    }

    const onNewChat = () => {
        setIsOpen(true)
        setCurrentChatId(null)
        setInput('')
        reload()
    }

    const onSelectChat = (chatId: string) => {
        setCurrentChatId(chatId)
        setIsOpen(false)
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
                <Button onClick={onNewChat} className="w-full" variant="outline">
                    + 新建对话
                </Button>
            </div>
            {/* 侧边栏 */}
            <Siderbar
                isOpen={isOpen}
                onClose={onClose}
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
