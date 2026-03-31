'use client'

import { useState,useCallback } from "react"
import { Message,ChatCompletionMessage } from "@/types/chat"
import { generateId } from "@/lib/utils"
import { setAbortedLogsStyle } from "next/dist/server/node-environment-extensions/console-dim.external"

// 发送对话的配置项
interface UseChatOptions{
    api?:string
    model?:string
    initialMessages?:Message[]
}

// 返回类型
interface UseChatReturn{
    messages:Message[]
    input:string//用户输入
    isLoading:boolean
    setInput:(value:string)=>void
    append:(content:string)=>Promise<void>//发送用户问题接收ai回复内容
    reload:()=>void//重置
    stop:()=>void//停止发送
}

export function useChat(options:UseChatOptions={}):UseChatReturn{
    const {api='/api/chat',model='Qwen2.5',initialMessages=[]}=options

    const [messages,setMessages]=useState<Message[]>(initialMessages)
    const [input,setInput]=useState('')
    const [isLoading,setIsLoading]=useState(false)
    const [abortController, setAbortController] = useState<AbortController | null>(null);

    // 发送消息，请求方法不需要每次渲染都重新创建，只需要变更模型，接口，发送内容时重新创建即可
    const append=useCallback(async(content:string)=>{
        if(!content.trim())return;
        // 创建用户信息
        const userMessage:Message={
            id:generateId(),
            role:'user',
            content:content.trim(),
            createdAt:new Date(),
        }

        // 初始化回复信息占位
        const assistantMessage:Message={
            id:generateId(),
            role:'assistant',
            content:'',
            createdAt:new Date(),
        }

        // 更新展示的消息列表
        setMessages([...messages,userMessage,assistantMessage])
        // 清空内容
        setInput('')
        setIsLoading(true)

        // 创建取消请求
        const abortController=new AbortController()
        setAbortController(abortController)

        // 发送请求
        try{
            // 准备发送的消息
            const apiMessages:ChatCompletionMessage[]=[
                // 解构去掉空的ai占位消息
                ...messages,
                userMessage
            ].map((message)=>({
                role:message.role,
                content:message.content
            }))

            // 发送请求
            const res=await fetch(api,{
                method:'POST',
                headers:{'Content-Type':'application/json'},
                body:JSON.stringify({
                    model,
                    messages:apiMessages,
                    stream:true
                }),
                signal:abortController.signal
            })

            // 接收流式响应
            if(!res.ok)throw new Error('http error status:'+res.status)
            // 获取reader
            const reader=res.body?.getReader()
            // 读取chunks
            const decoder=new TextDecoder()
            if(!reader)return 
            // 解析数据
            let accumulatedContent=''
            // 累积更新消息内容
            while(true){
                const {done,value}=await reader.read()
                if(done)break;

                const chunks=decoder.decode(value,{stream:true})
                const lines=chunks.split('\n')

                for(const line of lines){
                    const data=line.slice(6)//去掉data: 前缀
                    if(data==='[DONE]')continue;

                    try{
                        const parsed=JSON.parse(data)
                        const content=parsed.choices?.[0]?.delta?.content
                        if(content){
                            accumulatedContent+=content
                            // 更新
                            setMessages((pre)=>pre.map((m)=>m.id===assistantMessage.id?{...m,content:accumulatedContent}:m))
                        }
                    }catch(e){
                        console.error('解析数据失败',e)
                    }
                }
            }
        }catch(e){
            
        }
    },[messages,model,api])
}
