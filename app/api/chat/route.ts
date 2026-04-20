import { NextRequest } from 'next/server'
import { auth } from "@/auth"

const OLLAMA_BASE_URL = process.env.NEXT_PUBLIC_OLLAMA_BASE_URL
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL

const MAX_RETRIES = 3
const FALLBACK_MESSAGE = '抱歉,服务器出错了'

// 重试中断时间
function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

// 兜底响应函数
function fallbackStreamResponse() {
    const encoder = new TextEncoder()

    const stream = new ReadableStream({
        start(controller) {
            // 模仿流式响应的格式
            const fallbackchunk = `data:${JSON.stringify({
                choices: [
                    {
                        delta: {
                            content: FALLBACK_MESSAGE
                        }
                    }
                ]
            })}\n\n`
            controller.enqueue(encoder.encode(fallbackchunk))
            controller.enqueue(encoder.encode(`data:[DONE]\n\n`))
            controller.close()
        }
    })

    return new Response(stream, {
        status: 200,
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Connection': 'keep-alive'
        }
    })
}

function fallbackJsonResponse() {
    return Response.json({
        choices: [
            {
                message: {
                    role: 'assistant',
                    content: FALLBACK_MESSAGE
                }
            }
        ]
    },
        {
            status: 200
        }
    )
}

export async function POST(req: NextRequest) {
    const session = await auth()
    if (!session?.user?.id) {
        return new Response("Unauthorized", {
            status: 401
        })
    }
    try {
        if (!OPENROUTER_API_KEY) {
            return new Response(
                JSON.stringify({ error: 'OPENROUTER_API_KEY is not configured' }),
                { status: 500 }
            )
        }
        if (!OPENROUTER_BASE_URL) {
            return new Response(
                JSON.stringify({ error: 'OPENROUTER_BASE_URL is not configured' }),
                { status: 500 }
            )
        }
        // 接收请求体
        const body = await req.json()
        const { model = 'openai/gpt-3.5-turbo:free', messages, stream = true } = body
        // 给请求体做基础校验
        if (!Array.isArray(messages) || messages.length === 0) {
            return stream ? fallbackStreamResponse() : fallbackJsonResponse()
        }

        let response: Response | null = null
        let lastErr: unknown = null
        let lastErrText = ''
        let aborted = false
        // 调用API获取AI输出
        for (let i = 0; i < MAX_RETRIES; i++) {
            if (aborted) {
                return new Response(null, { status: 204 })
            }
            try {
                response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${OPENROUTER_API_KEY}`
                    },
                    body: JSON.stringify({
                        model,
                        messages,
                        stream
                    }),
                    signal: req.signal
                })
                // 用户主动中断，直接退出重试
                if (req.signal.aborted) {
                    throw new DOMException('Aborted', 'AbortError')
                }
                if (response.ok) {
                    // 提前结束
                    break
                }
                lastErrText = await response.text()
                console.error(`OpenRouter request failed, attempt ${i}/${MAX_RETRIES}`,
                    {
                        status: response.status,
                        text: lastErrText
                    }
                )
            } catch (err) {
                if ((err as Error).name === 'AbortError') {
                    aborted = true
                    return new Response(null, { status: 204 })
                }
                lastErr = err
                console.error(`OpenRouter request exception, attempt ${i}/${MAX_RETRIES}`, err)
            }

            if (i < MAX_RETRIES - 1) {
                await sleep(i * 500)
            }
        }
        if (!response?.ok) {
            if (aborted) {
                // 不需要fallback
                return
            }
            console.error('OpenRouter failed after max retries', {
                lastErr,
                lastErrText
            })
            return stream ? fallbackStreamResponse() : fallbackJsonResponse()
        }

        // 流式响应
        if (stream) {
            return new Response(response?.body, {
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
        return fallbackStreamResponse()
    }
}
