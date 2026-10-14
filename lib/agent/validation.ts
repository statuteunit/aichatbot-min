// lib/agent/validation.ts
// P3「受控验证执行」的任务注册表与执行器。
// 核心不变量：模型**只能提供一个 taskId**，永远拿不到 argv。
// taskId → argv 的映射写死在下面的 VALIDATION_TASKS 里，
// 所以「模型能不能拼出 rm -rf /」这个问题在类型层面就不存在 ——
// inputSchema 里根本没有任何可以放命令字符串的字段。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { ToolError } from './security'

const execFileAsync = promisify(execFile)

export type ValidationTaskId = 'lint' | 'typecheck' | 'test'

export interface ValidationTask {
  id: ValidationTaskId
  label: string
  /** 相对工作区根的 node 入口（不含解释器） */
  entry: string
  /** 固定参数：这里出现的任何东西都来自代码，不来自模型 */
  args: readonly string[]
  timeoutMs: number
  /** 给人看的说明，会出现在 prompt 与工具返回值里 */
  description: string
}

/** product-spec：验证任务最大 60s */
export const VALIDATION_MAX_TIMEOUT_MS = 60_000
/** 单条流（stdout / stderr 各自）的截断上限 */
export const VALIDATION_MAX_OUTPUT_BYTES = 40 * 1024

/**
 * ⚠️ 为什么 argv 是 `node <node_modules/...js>` 而不是 `pnpm run lint`：
 *   Windows 上 pnpm / eslint / tsc / tsx 都是 .cmd 垫片，execFile 在 shell:false 下
 *   要么 ENOENT，要么在 Node ≥18.20.2 上抛 EINVAL。scripts/db.mjs 已经为同一个原因
 *   绕过 node_modules/.bin/prisma.cmd 改用 `node <prisma>/build/index.js`，这里沿用同一策略。
 */
export const VALIDATION_TASKS: Record<ValidationTaskId, ValidationTask> = {
  lint: {
    id: 'lint',
    label: 'ESLint',
    entry: 'node_modules/eslint/bin/eslint.js',
    args: ['.'],
    timeoutMs: 60_000,
    description: 'eslint .（不加 --fix，绝不改写文件）',
  },
  typecheck: {
    id: 'typecheck',
    label: 'TypeScript 类型检查',
    entry: 'node_modules/typescript/lib/tsc.js',
    args: ['--noEmit', '--incremental', 'false', '--pretty', 'false'],
    timeoutMs: 60_000,
    description: 'tsc --noEmit --incremental false（不写 tsbuildinfo、不产出文件）',
  },
  test: {
    id: 'test',
    label: '单元测试',
    entry: 'node_modules/tsx/dist/cli.mjs',
    args: ['--test', 'tests/**/*.test.ts'],
    timeoutMs: 60_000,
    description: 'tsx --test tests/**/*.test.ts',
  },
}

export const VALIDATION_TASK_IDS = Object.keys(VALIDATION_TASKS) as ValidationTaskId[]

export function isValidationTaskId(value: unknown): value is ValidationTaskId {
  // 用 hasOwnProperty：否则 'toString' / 'constructor' 这类原型链上的键会被误判为合法
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(VALIDATION_TASKS, value)
}

/**
 * 子进程环境白名单。
 *
 * product-spec：验证任务「不得访问数据库、网络或环境变量」。
 * POSTGRES_* / AUTH_* / OPENROUTER_API_KEY / AGENT_* 一律不透传 ——
 * 因为 `test` 会执行仓库里的任意代码，把密钥塞进它的环境等于把凭据交给被测代码。
 * NODE_OPTIONS 也故意不给：它能让子进程加载任意模块，等于开后门。
 */
export const VALIDATION_ENV_ALLOWLIST = [
  'PATH', 'Path',
  'SystemRoot', 'SYSTEMROOT', 'windir', 'COMSPEC', 'PATHEXT',
  'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
  'LANG', 'LC_ALL',
] as const

export function buildValidationEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of VALIDATION_ENV_ALLOWLIST) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) env[key] = value
  }
  // CI=1 让工具链不进 watch / 交互模式；NO_COLOR=1 让日志稳定，便于截断与断言
  env.CI = '1'
  env.NO_COLOR = '1'
  return env
}

/** 按字节截断（不能用 String.length：UTF-16 码元数会把中文低估 3 倍） */
export function truncateUtf8(
  text: string,
  maxBytes: number = VALIDATION_MAX_OUTPUT_BYTES,
): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.byteLength <= maxBytes) return { text, truncated: false }
  return {
    text: `${buffer.subarray(0, maxBytes).toString('utf8')}\n…（输出已截断，仅保留前 ${maxBytes} 字节）`,
    truncated: true,
  }
}

export interface ValidationCommand {
  command: string
  args: string[]
  cwd: string
  timeoutMs: number
  env: Record<string, string>
}

/** 把注册任务翻译成一条**完全由服务端决定**的命令 */
export async function buildValidationCommand(
  taskId: ValidationTaskId,
  workspaceRoot: string,
): Promise<ValidationCommand> {
  const task = VALIDATION_TASKS[taskId]
  const entry = path.resolve(workspaceRoot, task.entry)
  try {
    await stat(entry)
  } catch {
    throw new ToolError(
      'VALIDATION_UNAVAILABLE',
      `验证任务 ${taskId} 的入口不存在：${task.entry}（请先安装开发依赖）`,
    )
  }
  return {
    // 用 process.execPath 而不是 'node'：不依赖 PATH 里有 node，也不依赖 shell
    command: process.execPath,
    args: [entry, ...task.args],
    cwd: workspaceRoot,
    timeoutMs: Math.min(task.timeoutMs, VALIDATION_MAX_TIMEOUT_MS),
    env: buildValidationEnv(),
  }
}

export interface ValidationOutcome {
  ok: boolean
  taskId: ValidationTaskId
  exitCode: number | null
  durationMs: number
  stdout: string
  stderr: string
  truncated: boolean
}

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
 * 执行注册的验证任务。
 *
 * 与 lib/agent/exec.ts 的 runGit 同构：**绝不经过 shell**（argv 数组 + shell:false），
 * 并且把「非零退出码」当成**正常结果**而不是异常 —— 验证失败是信息，不是故障。
 */
export async function runValidationTask(
  taskId: ValidationTaskId,
  workspaceRoot: string,
): Promise<ValidationOutcome> {
  const cmd = await buildValidationCommand(taskId, workspaceRoot)
  const startedAt = Date.now()

  try {
    const { stdout, stderr } = await execFileAsync(cmd.command, cmd.args, {
      cwd: cmd.cwd,
      timeout: cmd.timeoutMs,
      windowsHide: true,
      encoding: 'utf8',
      shell: false, // ← 关键：绝不走 shell
      maxBuffer: VALIDATION_MAX_OUTPUT_BYTES * 5, // 留余量，真正超限时靠下面的 catch 兜住
      env: cmd.env as NodeJS.ProcessEnv, // 构造器给出的是 Record<string,string>，execFile 要 ProcessEnv
    })
    const out = truncateUtf8(stdout)
    const err = truncateUtf8(stderr)
    return {
      ok: true,
      taskId,
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      stdout: out.text,
      stderr: err.text,
      truncated: out.truncated || err.truncated,
    }
  } catch (error) {
    const e = error as ExecErrorLike
    const out = truncateUtf8(toText(e.stdout))
    const err = truncateUtf8(toText(e.stderr))

    // 超时被 kill：error.killed=true 且 code 为 null（signal 终止）
    if (e.killed) {
      throw new ToolError('VALIDATION_TIMEOUT', `验证任务 ${taskId} 超时（${cmd.timeoutMs}ms）`)
    }

    // 输出超过 maxBuffer：不是"失败"，是"内容太多被截断"
    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER_STDERR') {
      return {
        ok: false,
        taskId,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        stdout: out.text,
        stderr: err.text,
        truncated: true,
      }
    }

    // 根本没起来（入口被删、无执行权限）→ 明确报错，不要伪装成"验证失败"
    if (e.code === 'ENOENT' || e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EINVAL') {
      throw new ToolError('VALIDATION_UNAVAILABLE', `无法启动验证任务 ${taskId}（${e.code}）：${e.message ?? ''}`)
    }

    // 正常退出但码非 0：验证失败，stdout/stderr 有诊断价值，保留
    if (typeof e.code === 'number') {
      return {
        ok: false,
        taskId,
        exitCode: e.code,
        durationMs: Date.now() - startedAt,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
      }
    }

    throw new ToolError('INTERNAL_ERROR', `验证任务 ${taskId} 执行异常：${e.message ?? String(error)}`)
  }
}