// scripts/print-analysis-schema.mjs
// 确认 RequirementAnalysisSchema 能被转成 JSON Schema，且 unrepresentable 为空
import { z } from 'zod'
import { RequirementAnalysisSchema } from '../lib/agent/schemas.ts'   // 需 tsx

// 导出schemas
const jsonSchema = z.toJSONSchema(RequirementAnalysisSchema)
console.log(JSON.stringify(jsonSchema, null, 2))