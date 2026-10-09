// tests/eval/run.eval.ts
//
// Eval 运行入口（手动执行，**不进 CI**）。
//
// 用法：
//   pnpm exec tsx tests/eval/run.eval.ts            # 只跑确定性用例（零成本）
//   pnpm exec tsx tests/eval/run.eval.ts --model    # 额外跑有模型的用例（消耗 token）
//
// 为什么默认只跑确定性用例：
//   有模型的用例要花钱且有波动。默认跑它会让"顺手执行一次"变成成本事件，
//   久而久之就没人跑了。让花成本的操作必须显式请求，是刻意的默认值选择。
import { generateText, stepCountIs, type UIMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import {
  DEFAULT_RUNS,
  DEFAULT_PASS_THRESHOLD,
  collectToolNames,
  formatSummaries,
  executionMode,
  runDeterministic,
  runWithTolerance,
  validateCases,
  type EvalCase,
  type EvalCaseSummary,
  type EvalResult,
} from './harness'
import { HONESTY_CASES } from './cases/honesty.eval'

/**
 * 与 app/api/chat 保持一致的 provider 配置。
 * 刻意重复这一段而不是从 route 里 import：
 *   route 带 'server-only'，Eval 跑在纯 Node 下会崩。
 *   两处配置漂移的风险由"Eval 结果异常"暴露，代价可接受。
 */
const openrouter = createOpenAI({
  baseURL: process.env.OPENROUTER_BASE_URL,
  apiKey: process.env.OPENROUTER_API_KEY,
})

/** 与 route.ts 的 MAX_STEPS 保持一致 */
const MAX_STEPS = 8

/**
 * 跑一次真实模型调用，产出 EvalResult。
 *
 * 这里**不注册工具**是刻意的：诚实降级用例测的是"模型在**没有**读到内容时的行为"，
 * 给它工具反而会引入"工具返回了什么"这个额外变量。
 * 需要工具参与的用例（如证据规范）应当在后续阶段单独建 runner，
 * 那时才需要引入 createGuardedAgentTools。
 */
async function runOnceModel(evalCase: EvalCase, runIndex: number): Promise<EvalResult> {
  const startedAt = Date.now()
  const model = process.env.EVAL_MODEL ?? 'openrouter/free'

  const messages: UIMessage[] = [
    { id: `eval-${evalCase.id}-${runIndex}`, role: 'user', parts: [{ type: 'text', text: evalCase.prompt }] },
  ]

  try {
    const result = await generateText({
      model: openrouter(model),
      // 用与产品一致的系统提示词：Eval 要评估的是**产品行为**，不是裸模型
      system:
        '你是这个代码仓库的分析 Agent（代号 Inspector）。只读、不编造、' +
        '找不到证据就明确说找不到。',
      messages: messages.map((m) => ({
        role: 'user' as const,
        content: (m.parts[0] as { text: string }).text,
      })),
      // 现在还没接工具，但保留 stopWhen 以便后续加工具时行为一致
      stopWhen: stepCountIs(MAX_STEPS),
    })

    return {
      evalCase,
      text: result.text,
      toolCalls: collectToolNames(result.steps ?? []),
      promptTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      durationMs: Date.now() - startedAt,
    }
  } catch (err) {
    return {
      evalCase,
      text: '',
      toolCalls: [],
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function main(): Promise<void> {
  const withModel = process.argv.includes('--model')

  // 所有用例集中在这里 —— 25 条回归的清单化位置
  const allCases: EvalCase[] = [
    ...HONESTY_CASES,
    // Day 18–21 的确定性用例已在 tests/agent/*.test.ts 落地（118 个断言），
    // 它们进 `pnpm run test` 而不是这里。此处只登记需要"用例化叙事"的部分。
  ]

  validateCases(allCases)

  const summaries: EvalCaseSummary[] = []

  // ── 确定性用例：跑一次，不允许波动 ──
  for (const c of allCases.filter((x) => executionMode(x) === 'deterministic')) {
    const outcome = await runDeterministic(c, {
      evalCase: c,
      workspaceRoot: process.cwd(),
    })
    summaries.push({
      evalCase: c,
      passed: outcome.passed,
      runs: 1,
      passedRuns: outcome.passed ? 1 : 0,
      passRate: outcome.passed ? 1 : 0,
      outcomes: [outcome],
    })
  }

  // ── 有模型用例：跑 N 次，达到阈值才算通过 ──
  if (withModel) {
    if (!process.env.OPENROUTER_API_KEY) {
      console.error('缺少 OPENROUTER_API_KEY，无法跑有模型的用例')
      process.exitCode = 1
      return
    }
    for (const c of allCases.filter((x) => executionMode(x) === 'model')) {
      const summary = await runWithTolerance(c, runOnceModel, {
        runs: DEFAULT_RUNS,
        passThreshold: DEFAULT_PASS_THRESHOLD,
      })
      summaries.push(summary)
    }
  } else {
    const skipped = allCases.filter((x) => executionMode(x) === 'model')
    if (skipped.length > 0) {
      console.log(`（跳过 ${skipped.length} 条有模型的用例；加 --model 参数运行）\n`)
    }
  }

  console.log(formatSummaries(summaries))

  // 退出码：任一用例未过即非 0，便于将来接进定时任务
  if (summaries.some((s) => !s.passed)) process.exitCode = 1
}

await main()
