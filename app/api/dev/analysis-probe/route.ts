// 骨架，测试校验功能
import { generateText, Output } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { RequirementAnalysisSchema } from '@/lib/agent/schemas'
import { validateAnalysis } from '@/lib/agent/validateAnalysis'

const openrouter = createOpenAI({
  baseURL: process.env.OPENROUTER_BASE_URL,
  apiKey: process.env.OPENROUTER_API_KEY,
})

export async function POST(req: Request) {
  const { requirement } = await req.json()
  const { output } = await generateText({
    model: openrouter('moonshotai/kimi-k2.5:free'),
    output: Output.object({ schema: RequirementAnalysisSchema }),
    prompt: `你是代码分析 Agent。针对以下需求做影响面分析，每条结论必须带 file:line 证据：
${requirement}`,
  })
  return Response.json(validateAnalysis(output))
}