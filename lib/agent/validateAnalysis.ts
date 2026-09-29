// 组织校验器调用校验规则，组织一些格式无法校验的逻辑
// lib/agent/validateAnalysis.ts
import { RequirementAnalysisSchema, type RequirementAnalysis } from './schemas'

export interface AnalysisViolation {
  path: string
  message: string
}

/**
 * 结构性校验交给 Zod；这里只做 JSON Schema 表达不了的领域规则。
 * 不要把这类规则写进 .refine() 再转 JSON Schema —— 转换会丢，provider 也可能拒绝。
 */
export function validateAnalysis(input: unknown):
  | { ok: true; data: RequirementAnalysis }
  | { ok: false; violations: AnalysisViolation[] } {
  const parsed = RequirementAnalysisSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      violations: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    }
  }

  const data = parsed.data
  const violations: AnalysisViolation[] = []
  const findings = [
    ...data.currentState.map((f, i) => [`currentState.${i}`, f] as const),
    ...data.impactScope.map((f, i) => [`impactScope.${i}`, f] as const),
  ]

  for (const [path, finding] of findings) {
    // 无证据的结论不得伪装成事实
    if (finding.confidence === 'confirmed' && finding.evidence.length === 0) {
      violations.push({ path, message: 'confidence=confirmed 但没有任何 file:line 证据' })
    }
    // 禁止编造路径
    if (finding.evidence.some((e) => e.file.startsWith('/') || e.file.includes('..'))) {
      violations.push({ path, message: `证据路径必须是仓库内相对路径：${finding.evidence.map((e) => e.file).join(', ')}` })
    }
  }

  // 推荐方案必须来自 options
  if (!data.options.some((o) => o.name === data.recommendation.optionName)) {
    violations.push({ path: 'recommendation.optionName', message: '推荐方案名必须出现在 options 中' })
  }

  return violations.length ? { ok: false, violations } : { ok: true, data }
}