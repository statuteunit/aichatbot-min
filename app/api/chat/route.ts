import { NextRequest } from 'next/server'

const OLLAMA_BASE_URL = process.env.NEXT_PUBLIC_OLLAMA_BASE_URL
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
const OPENROUTER_BASE_URL = process.env.NEXT_PUBLIC_OPENROUTER_BASE_URL

export async function POST(req: NextRequest) {
    try {
        if (!OPENROUTER_API_KEY) {
            return new Response(
                JSON.stringify({ error: 'OPENROUTER_API_KEY is not configured' }),
                { status: 500 }
            )
        }
        // 接收请求体
        const body = await req.json()
        const { model = 'openai/gpt-3.5-turbo:free', messages, stream = true } = body
        // 调用API获取AI输出
        const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`
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
