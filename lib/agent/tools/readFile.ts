// lib/agent/tools/readFile.ts
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
  symbolsOnly: z.boolean().optional().meta({
    description: 'true 时只返回导出/声明的签名行（function/class/interface/type/const），不返回实现体。' +
      '用于快速判断"这个文件是否相关"，比整文件读取省 90% 上下文。',
  }),
})

const DECL_PATTERN = /^\s*(export\s+)?(async\s+)?(function|class|interface|type|enum|const|let)\s/

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
  /** symbolsOnly 模式下命中多少个声明行。非该模式时为 undefined */
  symbolCount?: number
  /**
   * symbolsOnly 的提取方式。
   * 故意暴露出来：正则有已知精度上限（注释/字符串里的伪声明可能被漏掉或误抓），
   * 让调用方知道这是"近似"而不是"精确解析"。
   */
  extraction?: 'regex'
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

    // symbolsOnly：只返回声明行（export/function/class/interface/type/enum/const/let）。
    // 与行区间叠加使用 —— 给了 startLine/endLine 就只在这段里找声明。
    if (input.symbolsOnly) {
      const picked: Array<{ line: number; text: string }> = []
      for (let i = start - 1; i < end; i += 1) {
        if (DECL_PATTERN.test(lines[i])) {
          picked.push({ line: i + 1, text: lines[i] })
        }
      }
      return {
        ok: true,
        path: input.path,
        startLine: start,
        endLine: end,
        totalLines,
        // 同样带行号前缀，与普通模式保持一致，模型可以照抄作为证据
        content: picked.map((p) => `${p.line}: ${p.text}`).join('\n'),
        truncated: start > 1 || end < totalLines,
        symbolCount: picked.length,
        extraction: 'regex',
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