// lib/agent/tools/grep.ts
//
// 护栏标记 'server-only' 统一放在 lib/agent/tools/index.ts（工具的唯一出口），
// 本文件保持可被 node:test 直接引用。不要从客户端组件引用本文件（依赖 node:fs）。
import { readdir, readFile as fsReadFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  IGNORED_DIRS,
  LIMITS,
  getWorkspaceRoot,
  isSensitivePath,
  resolveWorkspaceFile,
  toToolErrorResult,
} from '../security'

export const GrepInputSchema = z.object({
  pattern: z.string().min(1).meta({ description: '正则表达式（JavaScript 语法，大小写敏感）' }),
  path: z.string().optional().meta({ description: '限定搜索的子目录或文件，默认整个仓库' }),
  glob: z.string().optional().meta({
    description: '文件名后缀过滤，如 ".ts" 或 ".tsx"；留空搜索常见源码类型',
  }),
  maxResults: z.number().int().min(1).max(LIMITS.grepHardMax).optional().meta({
    description: `最大命中数，默认 ${LIMITS.grepDefaultMax}`,
  }),
  context: z.number().int().min(0).max(10).optional().meta({
    description: '每个命中显示前后各 N 行上下文（类似 grep -C）。定位可疑逻辑时很有用，避免额外读文件。默认 0',
  }),
})

export type GrepInput = z.infer<typeof GrepInputSchema>

export interface GrepMatch {
  /** 相对仓库根路径 */
  path: string
  line: number
  text: string
  /**
   * 命中行之前 N 行的上下文（按行号升序）。未请求上下文时为空数组。
   *
   * 为什么上下文要带行号、而不是拼成一个字符串：
   *   模型引用证据时需要**准确行号**（product-spec §7.3 要求 file:line）。
   *   拼成字符串它就得自己数行，很容易算错。
   */
  before: Array<{ line: number; text: string }>
  /** 命中行之后 N 行的上下文（按行号升序）。未请求上下文时为空数组。 */
  after: Array<{ line: number; text: string }>
}

export interface GrepResult {
  ok: true
  pattern: string
  matches: GrepMatch[]
  truncated: boolean
  filesScanned: number
  /** 跳过的二进制/超大文件数，便于模型知道结果不是全覆盖 */
  filesSkipped: number
  /** 每个命中实际附带了几行上下文（0 表示只返回命中行本身） */
  context: number
}

/** 默认只搜这些扩展名，避免把二进制和生成物都读一遍 */
const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.json', '.prisma', '.md', '.sql']
const MAX_SCAN_BYTES = 512 * 1024

export async function grepTool(input: GrepInput): Promise<GrepResult | ReturnType<typeof toToolErrorResult>> {
  try {
    const root = getWorkspaceRoot()
    const maxResults = Math.min(input.maxResults ?? LIMITS.grepDefaultMax, LIMITS.grepHardMax)

    let regex: RegExp
    try {
      regex = new RegExp(input.pattern)
    } catch {
      return { ok: false, code: 'INVALID_INPUT', message: `正则表达式无效：${input.pattern}` }
    }

    // 起点默认整个工作区；path 为空 / '.' 都表示工作区根，走同一套护栏校验
    const startAbs = await resolveWorkspaceFile(root, input.path ?? '')
    const startInfo = await stat(startAbs)

    const matches: GrepMatch[] = []
    let filesScanned = 0
    let filesSkipped = 0
    let truncated = false

    // 上下文行数。上限由 LIMITS 统一管，工具内不写魔法数字。
    const context = Math.min(input.context ?? 0, LIMITS.grepContextMax)

    const extensionFilter = input.glob
      ? (name: string) => name.endsWith(input.glob as string)
      : (name: string) => DEFAULT_EXTENSIONS.some((ext) => name.endsWith(ext))

    async function scanFile(absFile: string, relFile: string) {
      if (truncated) return
      if (filesScanned >= LIMITS.grepMaxFilesScanned) {
        truncated = true
        return
      }
      if (isSensitivePath(relFile)) {
        filesSkipped += 1
        return
      }
      try {
        const info = await stat(absFile)
        if (!info.isFile() || info.size > MAX_SCAN_BYTES) {
          filesSkipped += 1
          return
        }
        const raw = await fsReadFile(absFile, 'utf8')
        // 粗略的二进制判断：含空字节
        if (raw.includes('\0')) {
          filesSkipped += 1
          return
        }
        filesScanned += 1

        const lines = raw.split(/\r?\n/)

        const clip = (s: string) => s.slice(0, LIMITS.matchLineChars)

        for (let i = 0; i < lines.length; i += 1) {
          // 注意：regex 没有 g 标志（new RegExp(pattern) 不带 flags），
          // 所以 .test() 不会在多次调用之间留下 lastIndex 状态。
          if (!regex.test(lines[i])) continue

          matches.push({
            path: relFile,
            line: i + 1,
            text: clip(lines[i]),
            // 上下文按行号升序。切片边界要夹住，避免越过文件首尾。
            before:
              context > 0
                ? lines
                    .slice(Math.max(0, i - context), i)
                    .map((text, k) => ({
                      line: Math.max(0, i - context) + k + 1,
                      text: clip(text),
                    }))
                : [],
            after:
              context > 0
                ? lines
                    .slice(i + 1, Math.min(lines.length, i + 1 + context))
                    .map((text, k) => ({ line: i + 2 + k, text: clip(text) }))
                : [],
          })

          if (matches.length >= maxResults) {
            truncated = true
            return
          }
        }
      } catch {
        filesSkipped += 1
      }
    }

    async function walk(currentAbs: string, currentRel: string) {
      if (truncated) return
      const dirents = await readdir(currentAbs, { withFileTypes: true })
      dirents.sort((a, b) => a.name.localeCompare(b.name))

      for (const dirent of dirents) {
        if (truncated) return
        const rel = currentRel ? `${currentRel}/${dirent.name}` : dirent.name
        if (dirent.isDirectory()) {
          if ((IGNORED_DIRS as readonly string[]).includes(dirent.name)) continue
          await walk(path.join(currentAbs, dirent.name), rel)
        } else if (dirent.isFile() && extensionFilter(dirent.name)) {
          await scanFile(path.join(currentAbs, dirent.name), rel)
        }
      }
    }

    if (startInfo.isFile()) {
      await scanFile(startAbs, input.path ?? path.basename(startAbs))
    } else {
      await walk(startAbs, input.path && input.path !== '.' ? input.path : '')
    }

    // 确定性输出：同一 pattern 在任何机器上返回同样的顺序。
    // 排序放在遍历之后统一做（原来在 scanFile 里每扫一个文件就排一次，纯浪费）。
    // 为什么必须确定：跨目录聚合的顺序依赖 readdir 的顺序，而它在 Windows 与
    // Linux 上不同 —— 顺序不稳定会让同一段对话在不同环境下表现不同，
    // 也让 Day 18–21 的 Eval 无法建立可比基线。
    matches.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)

    return {
      ok: true,
      pattern: input.pattern,
      matches,
      truncated,
      filesScanned,
      filesSkipped,
      context,
    }
  } catch (err) {
    return toToolErrorResult(err)
  }
}