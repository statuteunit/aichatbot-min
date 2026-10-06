// lib/agent/tools/gitLog.ts
import { z } from 'zod'
import { getWorkspaceRoot, resolveWorkspaceFile, toToolErrorResult } from '../security'
import { classifyGitFailure, runGit } from '../exec'

export const GitLogInputSchema = z.object({
  limit: z.number().int().min(1).max(50).optional().meta({
    description: '返回最近多少条提交，默认 10，最大 50',
  }),
  path: z.string().optional().meta({
    description: '只看某个文件或子目录的历史，如 hooks/useChat.ts；省略则看全仓库',
  }),
})

export type GitLogInput = z.infer<typeof GitLogInputSchema>

export interface GitCommit {
  hash: string
  /** 短 hash，便于在报告里引用 */
  shortHash: string
  author: string
  /** ISO 8601 日期 */
  date: string
  subject: string
}

export interface GitLogResult {
  ok: true
  commits: GitCommit[]
  /** 因为 limit 或字节上限被截断 */
  truncated: boolean
  /** git 以非零码退出时的诊断信息（如空仓库），此时 commits 为空 */
  diagnostic?: string
}

/** git log 每条记录的分隔符：用不可见字符避免与提交信息冲突 */
const RECORD_SEP = '\x1e'
const FIELD_SEP = '\x1f'
const LOG_FORMAT = `--pretty=format:%H${FIELD_SEP}%h${FIELD_SEP}%an${FIELD_SEP}%aI${FIELD_SEP}%s${RECORD_SEP}`

/** 解析 git log 输出；格式由上面的 LOG_FORMAT 固定，不依赖模型或用户的 locale */
export function parseGitLog(stdout: string): GitCommit[] {
  return stdout
    .split(RECORD_SEP)
    .map((record) => record.replace(/^\r?\n/, ''))   // 记录之间会有换行
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [hash = '', shortHash = '', author = '', date = '', ...rest] = record.split(FIELD_SEP)
      return { hash, shortHash, author, date, subject: rest.join(FIELD_SEP).trim() }
    })
    .filter((commit) => commit.hash.length > 0)
}

/** 把 classifyGitFailure 的结果包装成工具错误返回体 */
function gitFailureResult(result: { stdout: string; stderr: string; exitCode?: number }) {
  const classified = classifyGitFailure({ ...result, truncated: false, failed: true })
  if (!classified) return null
  return { ok: false as const, code: classified.code, message: classified.message }
}

export async function gitLog(
  input: GitLogInput,
): Promise<GitLogResult | ReturnType<typeof toToolErrorResult>> {
  try {
    const root = getWorkspaceRoot()
    const { limit = 10 } = input

    const args = ['log', `-n`, String(limit), LOG_FORMAT, '--date=iso']
    if (input.path) {
      // 路径同样走护栏：拒绝绝对路径、.. 穿越、敏感文件
      await resolveWorkspaceFile(root, input.path)
      args.push('--', input.path)
    }

    const result = await runGit(root, args, { timeoutMs: 15_000 })

    if (result.failed) {
      // 空仓库 / 非仓库：返回明确 code 而不是抛异常
      const failure = gitFailureResult(result)
      if (failure) return failure
    }

    const commits = parseGitLog(result.stdout)
    return {
      ok: true,
      commits,
      // limit 达到上限，或 git 输出被字节上限截断
      truncated: result.truncated || commits.length >= limit,
      ...(result.failed
        ? { diagnostic: result.stderr.trim() || `git 退出码 ${result.exitCode}` }
        : {}),
    }
  } catch (err) {
    return toToolErrorResult(err)
  }
}
