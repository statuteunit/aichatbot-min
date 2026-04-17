import { NextRequest } from 'next/server'
import { auth } from "@/auth"

const OLLAMA_BASE_URL = process.env.NEXT_PUBLIC_OLLAMA_BASE_URL
const openRouterBaseUrl=process.env.OPENROUTER_BASE_URL

export async function POST(req: NextRequest) {
    const session =await auth()
    if(!session?.user?.id){
        return new Response("Unauthorized",{
            status:401
        })
    }
    try {
        // 接收请求体
        const body = await req.json()
        const { model = 'llama3.2', messages, stream = true } = body
        // 调用API获取AI输出
        const response = await fetch(`${openRouterBaseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`
            },
            body: JSON.stringify({
                model,
                messages,
                stream
            })
        })

        if (!response.ok) {
            return new Response(
                JSON.stringify({ error: 'API Error' }),
                { status: response.status }
            )
        }
        // 流式响应
        if (stream) {
            return new Response(response.body, {
                headers: {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Connection': 'keep-alive'
                }
            })
        } else {
            // 非流式响应
            const data = await response.json()
            return Response.json(data)
        }
    } catch (err) {
        console.error('Error:', err)
        return new Response(
            JSON.stringify({ error: 'Internal server error' }),
            { status: 500 }
        )
    }
}
