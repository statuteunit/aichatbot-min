// lib/agent/tools/readFile.ts
//
// 护栏标记 'server-only' 统一放在 lib/agent/tools/index.ts（工具的唯一出口），
// 本文件保持可被 node:test 直接引用。不要从客户端组件引用本文件（依赖 node:fs）。
import { readFile as fsReadFile } from 'node:fs/promises'
import { z } from 'zod'
import {
  assertFileSize,
  getWorkspaceRoot,
  resolveWorkspaceFile,
  toToolErrorResult,
} from '../security'

export const ReadFileInputSchema = z.object({
  path: z.string().meta({ description: '相对仓库根的文件路径' }),
  startLine: z.number().int().min(1).optional().meta({ description: '起始行（1-based，含）' }),
  endLine: z.number().int().min(1).optional().meta({ description: '结束行（1-based，含）' }),
})

export type ReadFileInput = z.infer<typeof ReadFileInputSchema>

export interface ReadFileResult {
  ok: true
  /** 相对仓库根路径 */
  path: string
  startLine: number
  endLine: number
  totalLines: number
  content: string
  /** 是否因为行区间或大小上限被截断 */
  truncated: boolean
}

export async function readFileTool(input: ReadFileInput): Promise<ReadFileResult | ReturnType<typeof toToolErrorResult>> {
  try {
    const root = getWorkspaceRoot()
    const absPath = await resolveWorkspaceFile(root, input.path)
    await assertFileSize(absPath)

    const raw = await fsReadFile(absPath, 'utf8')
    const lines = raw.split(/\r?\n/)
    const totalLines = lines.length

    const start = Math.max(1, input.startLine ?? 1)
    const end = Math.min(totalLines, input.endLine ?? totalLines)
    if (start > end) {
      return {
        ok: false,
        code: 'INVALID_INPUT',
        message: `startLine(${start}) 大于 endLine(${end})`,
      }
    }

    const selected = lines.slice(start - 1, end)
    // 带上行号前缀，模型引用证据时可直接抄
    const content = selected
      .map((line, index) => `${start + index}: ${line}`)
      .join('\n')

    return {
      ok: true,
      path: input.path,
      startLine: start,
      endLine: end,
      totalLines,
      content,
      truncated: start > 1 || end < totalLines,
    }
  } catch (err) {
    return toToolErrorResult(err)
  }
}