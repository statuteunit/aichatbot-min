// lib/agent/schemas.ts
// 输入和输出内容格式校验
import { z } from 'zod'

/**
 * 每个事实性结论都带 `文件路径:行号`。
 * 注意：LLM 面向的 schema 里禁止出现 z.date()（无法转 JSON Schema）。
 */
export const EvidenceSchema = z.object({
  file: z.string().min(1).meta({ description: '相对仓库根的文件路径，如 hooks/useChat.ts' }),
  line: z.number().int().positive().optional().meta({ description: '行号；整文件引用时省略' }),
  note: z.string().optional().meta({ description: '这行代码说明了什么' }),
})

/** 置信度：输出结果来源的三种表达 */
export const ConfidenceSchema = z.enum(['confirmed', 'likely', 'unknown'])

export const FindingSchema = z.object({
  claim: z.string().min(1).meta({ description: '一条事实性结论，一句话' }),
  confidence: ConfidenceSchema.meta({
    description: 'confirmed=有 file:line 直接证据；likely=推测；unknown=未找到实现',
  }),
  evidence: z.array(EvidenceSchema).meta({
    description: 'confidence=confirmed 时至少 1 条；无证据必须标 unknown 或 likely',
  }),
})

export const SolutionOptionSchema = z.object({
  name: z.string().min(1),
  changes: z.array(z.string()).meta({ description: '改动点清单，每条写「改哪里 / 改什么」' }),
  pros: z.array(z.string()),
  cons: z.array(z.string()),
  riskLevel: z.enum(['low', 'medium', 'high']),
})

export const AnalysisStepSchema = z.object({
  file: z.string().min(1).meta({ description: '要改的文件路径' }),
  location: z.string().optional().meta({ description: '如 hooks/useChat.ts:150' }),
  reason: z.string().min(1).meta({ description: '为什么改' }),
  change: z.string().min(1).meta({ description: '怎么改' }),
})

/** 需求/影响面分析报告输出结构 */
export const RequirementAnalysisSchema = z.object({
  title: z.string().min(1),
  summary: z.array(z.string()).min(1).max(3).meta({
    description: '结论摘要，先给答案，最多 3 条',
  }),
  currentState: z.array(FindingSchema).meta({ description: '现状分析，带 file:line 证据' }),
  impactScope: z.array(FindingSchema).meta({ description: '影响面：文件清单与波及链路' }),
  options: z.array(SolutionOptionSchema).min(1).meta({ description: '至少 1 个方案，建议 2 个' }),
  recommendation: z.object({
    optionName: z.string().min(1),
    rationale: z.string().min(1),
    steps: z.array(AnalysisStepSchema).min(1),
  }),
  risks: z.array(z.string()).meta({ description: '风险与假设；假设必须显式声明' }),
  openQuestions: z.array(z.string()).meta({ description: '待确认问题' }),
})

export type RequirementAnalysis = z.infer<typeof RequirementAnalysisSchema>