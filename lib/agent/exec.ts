// lib/agent/exec.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ToolError, type ToolErrorCode } from './security'

const execFileAsync = promisify(execFile)

/** 固定子命令白名单：只读 git 操作 */
export const ALLOWED_GIT_SUBCOMMANDS = ['log', 'diff', 'status', 'show'] as const

/** 可能让 git 执行外部程序或改写仓库状态的参数，一律拒绝 */
const FORBIDDEN_GIT_ARGS = [
  '--exec', '--exec-path', '--upload-pack', '--receive-pack',
  '--git-dir', '--work-tree', '--config-env',
]

/** 单次输出的字节上限（stdout / stderr 各自） */
export const GIT_MAX_BYTES = 200 * 1024

// git操作结果类型枚举
export interface GitResult {
  /** 即使 failed=true 也可能有内容：git 常常「失败但有诊断输出」 */
  stdout: string
  stderr: string
  /** 是否因为超过 GIT_MAX_BYTES 而被截断 */
  truncated: boolean
  /** 子进程是否以非零码退出。注意这**不是**执行失败，是"git 说了不" */
  failed: boolean
  /** 退出码；仅在 failed=true 时有意义 */
  exitCode?: number
}

/** 输出超限的两个错误码：stdout 与 stderr 各有一份 maxBuffer */
const MAXBUFFER_CODES = new Set([
  'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
  'ERR_CHILD_PROCESS_STDIO_MAXBUFFER_STDERR',
])

/** 根本没能启动子进程的错误码 → 向上抛，让调用方给出明确 code */
const SPAWN_FAILURE_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'ENOTDIR'])

interface ExecErrorLike {
  code?: string | number
  killed?: boolean
  stdout?: string | Buffer
  stderr?: string | Buffer
  message?: string
}

function toText(value: string | Buffer | undefined): string {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return ''
}

/**
 * 执行白名单内的只读 git 子命令。
 * 绝不经过 shell（argv 数组 + shell: false）
 */
export async function runGit(
  cwd: string,
  args: string[],
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<GitResult> {
  const { timeoutMs = 10_000, maxBytes = GIT_MAX_BYTES } = options

  const sub = args[0]
  if (!ALLOWED_GIT_SUBCOMMANDS.includes(sub as (typeof ALLOWED_GIT_SUBCOMMANDS)[number])) {
    throw new ToolError('INVALID_INPUT', `不允许的 git 子命令：${String(sub)}`)
  }
  if (args.some((a) => FORBIDDEN_GIT_ARGS.includes(a) || a.startsWith('--exec='))) {
    throw new ToolError('INVALID_INPUT', 'git 参数包含禁止项')
  }

  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      // 留 5 倍余量：正常输出不会碰到它，真正超限时我们靠 catch 兜住
      maxBuffer: maxBytes * 5,
      encoding: 'utf8',
      shell: false,   // ← 关键：绝不走 shell
      env: {
        // 保留 process.env 而不是只给 PATH：Windows 上 git 依赖 SystemRoot / COMSPEC /
        // PATHEXT / LOCALAPPDATA 等变量才能正常工作并找到 .gitconfig。
        // 当前实现只传 PATH 是个隐患。
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',   // 禁止交互式索要凭据
        GIT_PAGER: 'cat',           // 禁止分页器（否则子进程可能挂住）
        GIT_OPTIONAL_LOCKS: '0',    // 只读操作不要抢 index.lock
      },
    })
    return {
      stdout,
      stderr,
      // 按**字节**判断，不能用 stdout.length（UTF-16 码元数，中文会低估 3 倍）
      truncated: Buffer.byteLength(stdout, 'utf8') > maxBytes,
      failed: false,
    }
  } catch (err) {
    const e = err as ExecErrorLike

    // 输出超限：不是"失败"，是"内容太多被截断"。error 上带着已捕获的部分输出。
    if (typeof e.code === 'string' && MAXBUFFER_CODES.has(e.code)) {
      const stdout = toText(e.stdout)
      const stderr = toText(e.stderr)
      return { stdout, stderr, truncated: true, failed: false }
    }

    // 子进程没能启动（git 未安装、无执行权限等）→ 明确的 GIT_UNAVAILABLE。
    // product-spec §3.4：代码源不可用要明确报错并降级，不能静默编造。
    if (typeof e.code === 'string' && SPAWN_FAILURE_CODES.has(e.code)) {
      throw new ToolError(
        e.code === 'ENOENT' ? 'GIT_UNAVAILABLE' : 'INTERNAL_ERROR',
        e.code === 'ENOENT'
          ? '当前环境没有可用的 git 可执行文件'
          : `无法执行 git（${e.code}）：${e.message ?? '未知原因'}`,
      )
    }

    // 子进程正常退出但码非 0：git 的常规失败语义，stdout/stderr 有诊断价值，保留
    if (typeof e.code === 'number') {
      const stdout = toText(e.stdout)
      const stderr = toText(e.stderr)
      return {
        stdout,
        stderr,
        truncated: Buffer.byteLength(stdout, 'utf8') > maxBytes,
        failed: true,
        exitCode: e.code,
      }
    }

    // 超时被 kill：killed=true 且 code 为 null（signal 终止）
    if (e.killed) {
      throw new ToolError('GIT_TIMEOUT', `git 执行超时（${timeoutMs}ms）`)
    }

    throw new ToolError('INTERNAL_ERROR', `git 执行异常：${e.message ?? String(err)}`)
  }
}

/** 把 git 的失败语义翻译成工具层的稳定错误码，供 gitLog / gitDiff 复用 */
export function classifyGitFailure(
  result: GitResult,
): { code: ToolErrorCode; message: string } | null {
  if (!result.failed) return null
  const text = `${result.stdout}\n${result.stderr}`
  if (/not a git repository/i.test(text)) {
    return { code: 'NOT_A_REPO', message: '当前工作区不是 git 仓库' }
  }
  if (/does not have any commits yet|unknown revision/i.test(text)) {
    return { code: 'EMPTY_REPO', message: 'git 仓库还没有任何提交' }
  }
  return { code: 'GIT_FAILED', message: result.stderr.trim() || `git 退出码 ${result.exitCode}` }
}