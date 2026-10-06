// lib/agent/security.ts
//
// 关于 'server-only'：本文件**故意不加**该标记，因为它需要能被 node:test 直接单测。
// 护栏统一收敛在 lib/agent/tools/index.ts —— 那是 Agent 工具对外的唯一出口。
// 不要从客户端组件引用本文件（它依赖 node:fs）。
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

/** 错误码 */
export type ToolErrorCode =
  | 'PATH_DENIED'
  | 'SENSITIVE_FILE_DENIED'
  | 'NOT_FOUND'
  | 'OUTPUT_TOO_LARGE'
  | 'INVALID_INPUT'
  | 'INTERNAL_ERROR'
  // git 类工具的错误码（对应 product-spec §3.4「代码源不可用」的降级要求）：
  // 环境没有 git / 不是仓库 / 空仓库都必须是**明确的 code**，
  // 既不能让模型看到含糊的 INTERNAL_ERROR，也不能让整个分析崩掉。
  | 'GIT_UNAVAILABLE'
  | 'GIT_TIMEOUT'
  | 'NOT_A_REPO'
  | 'EMPTY_REPO'
  | 'GIT_FAILED'

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

/**
 * 按文件名（basename）在工作区内搜索同名文件，返回相对路径候选。
 *
 * 为什么需要它：模型在证据里经常只写文件名而不是完整相对路径
 * （实测：`prompt.ts:27`、`index.ts:23-25`，真实路径是 lib/agent/prompt.ts）。
 * 此时按字面路径查会 404，用户点到的链接变成"死链"——这不是预期的交互。
 *
 * 语义约束（很关键，避免解析出歧义结果）：
 *   - 只用于**兜底**：调用方必须先按字面路径查一次，查不到才来这里
 *   - 命中 1 个 → 可以安全地用它；命中多个 → 必须让调用方报"歧义"而不是随便挑一个
 *   - 仍然遵守敏感文件屏蔽与忽略目录，不会因为"搜索"就绕过护栏
 *
 * 性能：有界遍历（深度 + 文件数上限）。仓库再大也不会失控。
 */
export async function findFilesByBasename(params: {
  workspaceRoot: string
  basename: string
  maxResults?: number
  maxFiles?: number
  maxDepth?: number
}): Promise<string[]> {
  const { workspaceRoot, basename, maxResults = 20, maxFiles = 8000, maxDepth = 8 } = params

  // 只接受纯文件名，避免把相对路径片段也拿来搜
  if (!basename || basename.includes('/') || basename.includes('\\') || basename === '.' || basename === '..') {
    return []
  }

  const root = await realpathWorkspaceRoot(workspaceRoot)
  const matches: string[] = []
  let visited = 0

  async function walk(absDir: string, relDir: string, depth: number): Promise<void> {
    if (depth > maxDepth || matches.length >= maxResults || visited >= maxFiles) return

    let dirents
    try {
      dirents = await readdir(absDir, { withFileTypes: true })
    } catch {
      return   // 无权限的目录直接跳过，不影响其它分支
    }

    for (const dirent of dirents) {
      if (matches.length >= maxResults || visited >= maxFiles) return
      const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name

      if (dirent.isDirectory()) {
        if ((IGNORED_DIRS as readonly string[]).includes(dirent.name)) continue
        // 不跟随符号链接（dirent.isDirectory() 对软链返回 false），与 listDir 一致
        await walk(path.join(absDir, dirent.name), rel, depth + 1)
      } else if (dirent.isFile()) {
        visited += 1
        if (dirent.name !== basename) continue
        // 敏感文件不出现在候选里——否则"搜索"就成了绕过屏蔽的通道
        if (isSensitivePath(rel)) continue
        matches.push(rel)
      }
    }
  }

  await walk(root, '', 1)
  return matches
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

/** inspectSensitiveFilePath 的返回体：只有结构信息，没有任何值 */
export interface SensitiveFileStructure {
  path: string
  exists: boolean
  /** 总行数；文件不存在时为 0 */
  totalLines: number
  byteSize: number
  /**
   * 只含**键名**，不含值。
   * 解析规则：跳过空行与 `#` 注释，取第一个 `=` 之前的 trimmed 文本。
   */
  keys: string[]
  /** 键名数量达到上限，说明还有未列出的键 */
  keysTruncated: boolean
}

/**
 * 读取一个**敏感文件的结构**（键名 + 行数 + 字节数），**永不返回任何值**。
 *
 * 为什么单独写这个函数，而不是给 resolveWorkspaceFile 加一个 allowSensitive 开关：
 *   ① 它把「可以碰敏感文件」从「可以读敏感文件」里剥离出来。即使调用方被
 *      提示注入控制，拿到的也只有键名，没有密钥值。
 *   ② 无需在护栏内部开条件分支——护栏依旧对所有常规路径生效，
 *      这个函数是**唯一**被明确设计成"透明地看一眼"的入口，
 *      将来审计时可以只盯它一个。
 *
 * ⚠️ 调用方职责：必须先自行确认 path 是工作区内的相对路径
 *    （不要传绝对路径、不要传含 `..` 的路径）。这里为了能访问敏感文件，
 *    没有走 resolveWorkspaceFile（它会拒绝这些路径）。
 *    当前唯一调用方是 readSensitiveFile 工具，它在调用前用 `..` 做了显式校验。
 */
export async function inspectSensitiveFilePath(params: {
  workspaceRoot: string
  relativePath: string
  maxKeys?: number
}): Promise<SensitiveFileStructure> {
  const { workspaceRoot, relativePath, maxKeys = 50 } = params
  const absPath = path.resolve(workspaceRoot, relativePath)
  const result: SensitiveFileStructure = {
    path: relativePath,
    exists: false,
    totalLines: 0,
    byteSize: 0,
    keys: [],
    keysTruncated: false,
  }

  let info
  try {
    info = await stat(absPath)
  } catch {
    // 文件不存在不是错误——「.env 存在吗」本身就是有效的问题
    return result
  }
  if (!info.isFile()) {
    throw new ToolError('INVALID_INPUT', '目标不是普通文件')
  }

  // 上限远大于 LIMITS.fileBytes：敏感文件通常很小，但要防止有人把大文件伪装成 .env
  if (info.size > LIMITS.fileBytes) {
    throw new ToolError('OUTPUT_TOO_LARGE', `文件 ${info.size} 字节，超过上限 ${LIMITS.fileBytes}`)
  }

  const raw = await readFile(absPath, 'utf8')
  const lines = raw.split(/\r?\n/)
  const keys: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    if (!key) continue
    if (keys.length >= maxKeys) {
      result.keysTruncated = true
      break
    }
    if (!keys.includes(key)) keys.push(key)
  }

  result.exists = true
  result.totalLines = lines.length
  result.byteSize = info.size
  result.keys = keys
  return result
}