// lib/agent/tools/readSensitiveFile.ts
//
// 演练工具：带审批的「脱敏查看」。
//
// 为什么需要它：
//   ① 验证 needsApproval 流程能跑通（服务端不执行 → 发审批请求 → 用户决定 → 续流执行）
//   ② 验证审批通过后工具真的执行，而不是永远被拒
//   ③ 验证审批拒绝时模型能收到 reason 并调整策略
//
// ⚠️ 它**不读任何值**。这是刻意的设计，不是未完成：
//   security.ts 的 inspectSensitiveFilePath 只返回键名 / 行数 / 字节数。
//   即使遭遇提示注入、即使审批被误批，泄漏的也只有「存在哪些环境变量名」。
//   真正读取值的路径（readFile）依然被 SENSITIVE_FILE_DENIED 挡住 —— 护栏没有开洞。
import { z } from 'zod'
import { tool } from 'ai'
import {
  getWorkspaceRoot,
  inspectSensitiveFilePath,
  toToolErrorResult,
} from '../security'

export const ReadSensitiveFileInputSchema = z.object({
  path: z.string().min(1).meta({
    description: '要查看的敏感文件路径（相对仓库根），如 .env 或 config/server.key',
  }),
  reason: z.string().min(1).meta({
    description: '为什么需要查看它。用户会看到这个理由来决定是否批准',
  }),
})

export type ReadSensitiveFileInput = z.infer<typeof ReadSensitiveFileInputSchema>

export interface ReadSensitiveFileResult {
  ok: true
  path: string
  exists: boolean
  totalLines: number
  byteSize: number
  keys: string[]
  keysTruncated: boolean
  /** 明确告知模型：本次没有、也不会返回任何值 */
  note: string
}

const NOTE =
  '出于安全考虑，本工具只返回键名与文件结构，不返回任何值。' +
  '不要尝试用其他方式获取值（readFile / grep 都会拒绝该文件）。'

export async function readSensitiveFile(
  input: ReadSensitiveFileInput,
): Promise<ReadSensitiveFileResult | ReturnType<typeof toToolErrorResult>> {
  try {
    const { path: requestedPath } = input

    // 与 resolveWorkspaceFile 同样的路径校验，但**不调用它**——
    // 它会在敏感文件检查处拒绝本工具的合法输入。
    // 这里只做最必要的防越界，把「能否访问敏感文件」的判断留给
    // inspectSensitiveFilePath 的职责边界（它永不返回值）。
    if (requestedPath.includes('\0')) {
      return { ok: false, code: 'PATH_DENIED', message: 'path 含空字节' }
    }
    // 绝对路径与 .. 一律拒绝，保持与其余工具一致的安全姿态
    if (/^([a-zA-Z]:|[\\/])/.test(requestedPath)) {
      return { ok: false, code: 'PATH_DENIED', message: '不接受绝对路径' }
    }
    const segments = requestedPath.split(/[\\/]+/).filter((s) => s && s !== '.')
    if (segments.some((s) => s === '..')) {
      return { ok: false, code: 'PATH_DENIED', message: '路径不得包含 ..' }
    }

    const structure = await inspectSensitiveFilePath({
      workspaceRoot: getWorkspaceRoot(),
      relativePath: segments.join('/'),
    })

    return {
      ok: true,
      path: structure.path,
      exists: structure.exists,
      totalLines: structure.totalLines,
      byteSize: structure.byteSize,
      keys: structure.keys,
      keysTruncated: structure.keysTruncated,
      note: NOTE,
    }
  } catch (err) {
    return toToolErrorResult(err)
  }
}

/**
 * 交给模型的工具定义。
 *
 * needsApproval: true —— P2 语义，每次调用都要人工批准
 * 这是本仓库目前唯一需要审批的工具，用来把审批链路跑通。
 */
export const readSensitiveFileTool = tool({
  description:
    '查看被默认屏蔽的敏感文件（.env / *.key 等）的**结构**：文件是否存在、行数、包含哪些键名。' +
    '**不返回任何值**。需要用户逐次批准。用于确认「某个环境变量是否存在」这类问题。',
  inputSchema: ReadSensitiveFileInputSchema,
  needsApproval: true,
  execute: async (input) => readSensitiveFile(input),
})
