// lib/agent/tools/gitDiff.ts
import { z } from 'zod'
import { getWorkspaceRoot, resolveWorkspaceFile, toToolErrorResult } from '../security'
import { classifyGitFailure, runGit } from '../exec'

/**
 * git 的 ref 名校验。
 * 不校验会被 git 当成选项注入（如 `--output=/etc/x`），所以必须显式拒绝：
 *   - 以 '-' 开头的（否则会被解析成命令行选项）
 *   - 含空白、控制字符、'~'、'^'、':'、'?'、'*'、'['、'\' 等 git 保留字符
 * 允许：字母数字、'.'、'_'、'-'、'/'（分支名常见形态），以及 HEAD、commit hash
 */
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/

function isSafeRef(value: string): boolean {
  return SAFE_REF.test(value) && !value.includes('..')
}

export const GitDiffInputSchema = z.object({
  base: z.string().optional().meta({
    description: '基准 ref（如 HEAD、main、某个 commit hash）。省略则显示工作区未提交的改动',
  }),
  target: z.string().optional().meta({
    description: '目标 ref。与 base 一起给出时显示 base..target 的差异',
  }),
  path: z.string().optional().meta({ description: '只看某个文件或子目录的差异' }),
  statOnly: z.boolean().optional().meta({
    description: 'true 时只返回 --stat 摘要（改动文件与行数统计），不返回完整 diff 内容',
  }),
})

export type GitDiffInput = z.infer<typeof GitDiffInputSchema>

export interface GitDiffResult {
  ok: true
  base?: string
  target?: string
  /** commit hash → 行数统计，JSON 而非纯文本，便于模型稳定引用 */
  stats: Record<string, { insertions: number; deletions: number }>
  /** 涉及的文件路径（相对仓库根） */
  files: string[]
  /** unified diff 原文；statOnly=true 时为空 */
  diff: string
  truncated: boolean
  diagnostic?: string
}

/** 解析 `git diff --numstat` 输出：`<add>\t<del>\t<path>` */
export function parseNumstat(stdout: string): {
  stats: GitDiffResult['stats']
  files: string[]
} {
  const stats: GitDiffResult['stats'] = {}
  const files: string[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    const [addRaw, delRaw, ...pathParts] = line.split('\t')
    const file = pathParts.join('\t').trim()
    if (!file) continue
    // 二进制文件的 add/del 是 '-'
    const insertions = Number.parseInt(addRaw, 10)
    const deletions = Number.parseInt(delRaw, 10)
    stats[file] = {
      insertions: Number.isNaN(insertions) ? 0 : insertions,
      deletions: Number.isNaN(deletions) ? 0 : deletions,
    }
    files.push(file)
  }
  return { stats, files }
}

function gitFailureResult(result: { stdout: string; stderr: string; exitCode?: number }) {
  const classified = classifyGitFailure({ ...result, truncated: false, failed: true })
  if (!classified) return null
  return { ok: false as const, code: classified.code, message: classified.message }
}

export async function gitDiff(
  input: GitDiffInput,
): Promise<GitDiffResult | ReturnType<typeof toToolErrorResult>> {
  try {
    const root = getWorkspaceRoot()
    const { base, target, path: scopePath, statOnly = false } = input

    for (const [label, value] of [['base', base], ['target', target]] as const) {
      if (value !== undefined && !isSafeRef(value)) {
        return {
          ok: false,
          code: 'INVALID_INPUT',
          message: `${label} 不是合法的 git ref：${JSON.stringify(value)}`,
        }
      }
    }
    if (target && !base) {
      return { ok: false, code: 'INVALID_INPUT', message: '提供 target 时必须同时提供 base' }
    }

    // 路径同样走护栏
    const scopeArgs: string[] = []
    if (scopePath) {
      await resolveWorkspaceFile(root, scopePath)
      scopeArgs.push('--', scopePath)
    }

    const range = base ? (target ? [`${base}..${target}`] : [base]) : []

    // 行数统计：--numstat 是机器可读格式，不让模型去解析人类可读的 --stat
    const statRun = await runGit(root, ['diff', '--numstat', ...range, ...scopeArgs], {
      timeoutMs: 30_000,
    })
    if (statRun.failed) {
      const failure = gitFailureResult(statRun)
      if (failure) return failure
    }
    const { stats, files } = parseNumstat(statRun.stdout)

    // 完整 diff：statOnly 时跳过，省一次子进程与上下文预算
    let diff = ''
    let diffTruncated = false
    if (!statOnly) {
      const diffRun = await runGit(root, ['diff', ...range, ...scopeArgs], { timeoutMs: 30_000 })
      // 注意：不加 --exit-code，所以「有差异」不会让 git 返回 1；
      // 若此处仍 failed，说明是真实错误（非仓库等），已在上面处理
      diff = diffRun.stdout
      diffTruncated = diffRun.truncated
    }

    return {
      ok: true,
      ...(base ? { base } : {}),
      ...(target ? { target } : {}),
      stats,
      files,
      diff,
      truncated: statRun.truncated || diffTruncated,
      ...(statRun.failed
        ? { diagnostic: statRun.stderr.trim() || `git 退出码 ${statRun.exitCode}` }
        : {}),
    }
  } catch (err) {
    return toToolErrorResult(err)
  }
}
