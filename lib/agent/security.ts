// lib/agent/security.ts
//
// 关于 'server-only'：本文件**故意不加**该标记，因为它需要能被 node:test 直接单测。
// 护栏统一收敛在 lib/agent/tools/index.ts —— 那是 Agent 工具对外的唯一出口。
// 不要从客户端组件引用本文件（它依赖 node:fs）。
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'

/** 错误码 */
export type ToolErrorCode =
  | 'PATH_DENIED'
  | 'SENSITIVE_FILE_DENIED'
  | 'NOT_FOUND'
  | 'OUTPUT_TOO_LARGE'
  | 'INVALID_INPUT'
  | 'INTERNAL_ERROR'

export class ToolError extends Error {
  constructor(readonly code: ToolErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'ToolError'
  }
}

/** 输出上限 */
export const LIMITS = {
  /** readFile 单文件最大字节数 */
  fileBytes: 200 * 1024,
  /** grep 默认与最大命中数 */
  grepDefaultMax: 200,
  grepHardMax: 500,
  /** listDir 默认与最大深度 */
  listDepthDefault: 3,
  listDepthMax: 5,
  /** 单个匹配行的展示长度上限 */
  matchLineChars: 500,
  /** grep 扫描的文件数上限，防止遍历失控 */
  grepMaxFilesScanned: 5000,
} as const

/** 目录遍历时忽略的目录 */
export const IGNORED_DIRS = [
  'node_modules',
  '.next',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.turbo',
  '.vercel',
  'data',        // 本地同步标记等运行期数据
] as const

/**
 * 敏感文件屏蔽
 * 注意黑名单用「文件名/相对路径」匹配，且大小写不敏感（Windows 上 .ENV 也是敏感的）
 */
const SENSITIVE_BASENAMES = new Set(['.env', '.env.local', '.env.development', '.env.production'])
const SENSITIVE_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/i,          // .env / .env.local / .env.production ...
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /(^|\/)\.git\/config$/i,    // 仓库配置里可能有凭据
  /^id_rsa/i,
  /^id_ed25519/i,
]

/**
 * 允许的例外：这些是**模板/示例**，不含真实凭据，且对分析有用。
 * 有例外必须显式列出，避免「一刀切把 .env.example 也挡了」导致 Agent 看不到配置形状。
 */
const SENSITIVE_ALLOWLIST = new Set(['.env.example', '.env.sample', '.env.template'])

export function isSensitivePath(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join('/')
  const base = normalized.split('/').pop() ?? normalized

  if (SENSITIVE_ALLOWLIST.has(base)) return false
  if (SENSITIVE_BASENAMES.has(base)) return true
  return SENSITIVE_PATTERNS.some((re) => re.test(base) || re.test(normalized))
}

/**
 * 工作区根目录。
 * P0 只读工具作用于当前检出目录是允许的。
 * 用 env 可覆盖
 */
export function getWorkspaceRoot(): string {
  return path.resolve(process.env.AGENT_WORKSPACE_ROOT ?? process.cwd())
}

/**
 * 解析工作区根的真实路径。
 * 单独抽出来是为了给出比 INTERNAL_ERROR 更准确的错误信息：
 * 工作区根不存在是**配置问题**，不是模型越界。
 */
async function realpathWorkspaceRoot(workspaceRoot: string): Promise<string> {
  try {
    return await realpath(workspaceRoot)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw new ToolError('INTERNAL_ERROR', `工作区根不存在：${workspaceRoot}（检查 AGENT_WORKSPACE_ROOT 或运行目录）`)
    }
    throw new ToolError('INTERNAL_ERROR', `无法解析工作区根：${workspaceRoot}`)
  }
}

/**
 * 把模型给的相对路径解析成工作区内的绝对路径。
 * 解析后一定落在 workspaceRoot 之内，否则抛 PATH_DENIED。
 *
 * 工作区根的三种等价写法：`''`、`'.'`、`'./'` —— 都指 workspaceRoot 本身。
 * listDir / grep 在「不限定子目录」时会传空字符串，所以这几种必须被接受，
 * 而且同样要走 realpath 校验（若 workspaceRoot 本身是符号链接，要解析到真实位置）。
 */
export async function resolveWorkspaceFile(
  workspaceRoot: string,
  requestedPath: string,
): Promise<string> {
  if (typeof requestedPath !== 'string') {
    throw new ToolError('INVALID_INPUT', 'path 必须是字符串')
  }
  // 空字节注入
  if (requestedPath.includes('\0')) {
    throw new ToolError('PATH_DENIED', 'path 含空字节')
  }
  // 绝对路径一律拒绝（Windows 盘符、UNC、POSIX 根）
  if (path.isAbsolute(requestedPath) || /^[a-zA-Z]:/.test(requestedPath)) {
    throw new ToolError('PATH_DENIED', '不接受绝对路径')
  }
  // 分段校验：".." 任何形式都拒绝（先于文件系统操作，避免探测）
  // 归一化：'' / '.' / './' 都表示工作区根，分段后为空数组
  const segments = requestedPath
    .split(/[\\/]+/)
    .filter((s) => s && s !== '.')
  if (segments.some((s) => s === '..')) {
    throw new ToolError('PATH_DENIED', '路径不得包含 ..')
  }
  // 敏感文件：在碰文件系统之前就拒绝
  if (segments.length > 0 && isSensitivePath(segments.join('/'))) {
    throw new ToolError('SENSITIVE_FILE_DENIED', `拒绝访问敏感文件：${requestedPath}`)
  }

  // workspaceRoot 本身也要 realpath：它可能是符号链接（或大小写不一致的 Windows 路径）
  const root = await realpathWorkspaceRoot(workspaceRoot)

  // 关键：从 root 逐级 realpath，逐级校验，防止中间段是逃逸符号链接
  let current = root
  for (const segment of segments) {
    const candidate = path.resolve(current, segment)
    // 先做词法校验，再用 realpath 解析该段（若它是符号链接）
    const lexical = path.relative(root, candidate)
    if (lexical.startsWith('..') || path.isAbsolute(lexical)) {
      throw new ToolError('PATH_DENIED', '路径越出工作区')
    }
    try {
      current = await realpath(candidate)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new ToolError('NOT_FOUND', `路径不存在：${requestedPath}`)
      }
      throw new ToolError('INTERNAL_ERROR', `解析路径失败：${requestedPath}`)
    }
    const resolvedRelative = path.relative(root, current)
    if (resolvedRelative.startsWith('..') || path.isAbsolute(resolvedRelative)) {
      throw new ToolError('PATH_DENIED', '路径通过符号链接越出工作区')
    }
  }

  return current
}

/** 读取前的大小校验；超限抛 OUTPUT_TOO_LARGE，由工具决定是否截断 */
export async function assertFileSize(absPath: string, maxBytes = LIMITS.fileBytes): Promise<number> {
  const info = await stat(absPath)
  if (!info.isFile()) {
    throw new ToolError('INVALID_INPUT', '目标不是文件')
  }
  if (info.size > maxBytes) {
    throw new ToolError('OUTPUT_TOO_LARGE', `文件 ${info.size} 字节，超过上限 ${maxBytes}`)
  }
  return info.size
}

/** 统一的错误 → 工具返回体转换，保证模型看到的是稳定结构而不是堆栈 */
export function toToolErrorResult(err: unknown): { ok: false; code: ToolErrorCode; message: string } {
  if (err instanceof ToolError) {
    return { ok: false, code: err.code, message: err.message }
  }
  return {
    ok: false,
    code: 'INTERNAL_ERROR',
    message: err instanceof Error ? err.message : String(err),
  }
}