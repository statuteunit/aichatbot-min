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
})

export type GrepInput = z.infer<typeof GrepInputSchema>

export interface GrepMatch {
  /** 相对仓库根路径 */
  path: string
  line: number
  text: string
}

export interface GrepResult {
  ok: true
  pattern: string
  matches: GrepMatch[]
  truncated: boolean
  filesScanned: number
  /** 跳过的二进制/超大文件数，便于模型知道结果不是全覆盖 */
  filesSkipped: number
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
        for (let i = 0; i < lines.length; i += 1) {
          if (regex.test(lines[i])) {
            matches.push({
              path: relFile,
              line: i + 1,
              text: lines[i].slice(0, LIMITS.matchLineChars),
            })
            if (matches.length >= maxResults) {
              truncated = true
              return
            }
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

    return { ok: true, pattern: input.pattern, matches, truncated, filesScanned, filesSkipped }
  } catch (err) {
    return toToolErrorResult(err)
  }
}