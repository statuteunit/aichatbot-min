'use client'

import { useState, useCallback } from "react"
import { Message, ChatCompletionMessage } from "@/types/chat"
import { generateId } from "@/lib/utils"
// import { getMessagesByChatId, addMessage } from "@/lib/store"

// 发送对话的配置项
interface UseChatOptions {
    chatId?: string
    api?: string
    model?: string
    initialMessages?: Message[]
}

// 返回类型
interface UseChatReturn {
    messages: Message[]
    input: string//用户输入
    isLoading: boolean//是否正在加载中
    chatId?: string//当前对话的chatid
    setInput: (value: string) => void
    append: (content: string) => Promise<void>//发送用户问题接收ai回复内容
    reload: () => void//重置
    stop: () => void//停止发送
    setMessages: (messages: Message[]) => void//设置消息记录
}

export function useChat(options: UseChatOptions = {}): UseChatReturn {
    const { chatId, api = '/api/chat', model = 'Qwen2.5', initialMessages = [] } = options

    // const [messages, setMessages] = useState<Message[]>(initialMessages)
    const [input, setInput] = useState('')
    const [isLoading, setIsLoading] = useState(false)
    const [abortController, setAbortController] = useState<AbortController | null>(null);

    // 异步初始化消息记录当前对话的
    // 如果有 chatId，从存储加载消息
    // const [messages, setMessages] = useState<Message[]>(() => {
    //     if (chatId) {
    //         return getMessagesByChatId(chatId);
    //     }
    //     return [];
    // });
    const [messages, setMessages] = useState<Message[]>(initialMessages)
    // 发送消息，请求方法不需要每次渲染都重新创建，只需要变更模型，接口，发送内容时重新创建即可
    const append = useCallback(async (content: string) => {
        if (!content.trim()) return;
        // 创建用户信息
        const userMessage: Message = {
            id: generateId(),
            role: 'user',
            content: content.trim(),
            createdAt: new Date(),
        }

        // 初始化回复信息占位
        const assistantMessage: Message = {
            id: generateId(),
            role: 'assistant',
            content: '',
            createdAt: new Date(),
        }

        // 更新展示的消息列表
        setMessages([...messages, userMessage, assistantMessage])
        // 清空内容
        setInput('')
        setIsLoading(true)

        // 创建取消请求
        const abortController = new AbortController()
        setAbortController(abortController)

        // 添加消息
        // if (chatId) {
        //     addMessage(chatId, userMessage)
        //     addMessage(chatId, assistantMessage)
        // }

        // 发送请求
        try {
            // 准备发送的消息
            const apiMessages: ChatCompletionMessage[] = [
                // 解构去掉空的ai占位消息
                ...messages,
                userMessage
            ].map((message) => ({
                role: message.role,
                content: message.content
            }))

            // 发送请求
            const res = await fetch(api, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model,
                    messages: apiMessages,
                    stream: true
                }),
                signal: abortController.signal
            })

            // 接收流式响应
            if (!res.ok) throw new Error('http error status:' + res.status)
            // 获取reader
            const reader = res.body?.getReader()
            // 读取chunks
            const decoder = new TextDecoder()
            if (!reader) return
            // 解析数据
            let accumulatedContent = ''
            let buffer = ''
            // 累积更新消息内容
            while (true) {
                const { done, value } = await reader.read()
                if (done) break;

                buffer += decoder.decode(value, { stream: true })
                const lines = buffer.split('\n')
                // 把可能不完整的最后一行留到下一次buffer继续拼接
                buffer = lines.pop() ?? ''

                for (const line of lines) {
                    // 排除空行的情况
                    if (!line) continue
                    if (!line.startsWith('data:')) continue
                    const data = line.slice('data:'.length).trim()//去掉data:前缀和空格
                    if (data === '[DONE]') continue;

                    try {
                        const parsed = JSON.parse(data)
                        const content = parsed.choices?.[0]?.delta?.content
                        if (content) {
                            accumulatedContent += content
                            // 更新
                            setMessages((pre) => pre.map((m) => m.id === assistantMessage.id ? { ...m, content: accumulatedContent } : m))
                        }
                    } catch (e) {
                        console.error('解析数据失败', e)
                    }
                }
            }
        } catch (e) {
            if ((e as Error).name === 'AbortError') {
                console.log('aborted')
            } else {
                console.log('chat Err:', e);
                // 清空准备的占位消息
                setMessages(messages.filter((m) => m.id !== assistantMessage.id))
            }
        } finally {
            setIsLoading(false)
            setAbortController(null)
        }
    }, [messages, model, api, chatId])

    // 用户不满意输出,重新生成最后一条回复
    const reload = useCallback(() => {
        // 找到最后一次用户的问题
        const lastUserIndex = messages.findLastIndex((m) => m.role === 'user')
        if (lastUserIndex === -1) return;
        const lastUserMessage = messages[lastUserIndex]
        // 删除后面的信息
        setMessages((prev) => prev.slice(0, lastUserIndex))
        // 重新发送请求
        append(lastUserMessage.content)
    }, [messages, append])

    // 停止生成
    const stop = useCallback(() => {
        if (abortController) abortController.abort()
    }, [abortController])

    return {
        messages,
        input,
        isLoading,
        chatId,
        append,
        setInput,
        reload,
        stop,
        setMessages
    }
}
