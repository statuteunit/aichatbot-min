// lib/agent/tools/listDir.ts
//
// 护栏标记 'server-only' 统一放在 lib/agent/tools/index.ts（工具的唯一出口），
// 本文件保持可被 node:test 直接引用。不要从客户端组件引用本文件（依赖 node:fs）。
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  IGNORED_DIRS,
  LIMITS,
  getWorkspaceRoot,
  resolveWorkspaceFile,
  toToolErrorResult,
} from '../security'
import { stat } from 'node:fs/promises'

/** 工具输入：不要用 .strict()（转 JSON Schema 会带 additionalProperties:false，部分 provider 拒绝） */
export const ListDirInputSchema = z.object({
  path: z.string().meta({ description: '相对仓库根的目录路径，根目录用 "."' }),
  depth: z.number().int().min(1).max(LIMITS.listDepthMax).optional().meta({
    description: `递归深度，默认 ${LIMITS.listDepthDefault}，最大 ${LIMITS.listDepthMax}`,
  }),
})

export type ListDirInput = z.infer<typeof ListDirInputSchema>

export interface ListDirEntry {
  /** 相对仓库根的路径，可直接作为 readFile 的入参 */
  path: string
  type: 'file' | 'dir'
  size?: number
}

export interface ListDirResult {
  ok: true
  path: string
  depth: number
  entries: ListDirEntry[]
  /** 是否因为深度或数量上限被截断 */
  truncated: boolean
  totalScanned: number
}

const MAX_ENTRIES = 500

export async function listDir(input: ListDirInput): Promise<ListDirResult | ReturnType<typeof toToolErrorResult>> {
  try {
    const root = getWorkspaceRoot()
    const requested = input.path?.trim() || '.'
    const depth = input.depth ?? LIMITS.listDepthDefault

    // '' / '.' / './' 都表示工作区根，resolveWorkspaceFile 内部统一处理
    const absDir = await resolveWorkspaceFile(root, requested)

    const entries: ListDirEntry[] = []
    let totalScanned = 0
    let truncated = false

    async function walk(currentAbs: string, currentRel: string, remaining: number) {
      if (truncated) return
      const dirents = await readdir(currentAbs, { withFileTypes: true })
      // 稳定排序，便于模型与单测预测
      dirents.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name)
      })

      for (const dirent of dirents) {
        totalScanned += 1
        if (entries.length >= MAX_ENTRIES) {
          truncated = true
          return
        }
        const rel = currentRel ? `${currentRel}/${dirent.name}` : dirent.name

        if (dirent.isDirectory()) {
          if ((IGNORED_DIRS as readonly string[]).includes(dirent.name)) continue
          entries.push({ path: rel, type: 'dir' })
          if (remaining > 1) {
            await walk(path.join(currentAbs, dirent.name), rel, remaining - 1)
          } else {
            truncated = true
          }
        } else if (dirent.isFile()) {
          const info = await stat(path.join(currentAbs, dirent.name))
          entries.push({ path: rel, type: 'file', size: info.size })
        }
        // 符号链接等其它类型直接跳过，不跟随（避免逃逸）
      }
    }

    await walk(absDir, requested === '.' ? '' : requested, depth)

    return { ok: true, path: requested, depth, entries, truncated, totalScanned }
  } catch (err) {
    return toToolErrorResult(err)
  }
}