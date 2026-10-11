// lib/agent/workspace.ts
// 工作区的基础操作：读取文件内容、计算 hash、拼出仓库级 workspaceId。
// 复用 resolveWorkspaceFile 而不是自己解析路径：
//   路径白名单、敏感文件屏蔽、忽略目录、符号链接逃逸校验都在那里。
//   自己再写一遍必然漂移，而这是护栏最容易失效的方式。
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { ToolError, getWorkspaceRoot, resolveWorkspaceFile } from './security'

/**
 * 空内容的 sha256。
 *
 * 用途：**新增文件**的基线 hash。
 * 不是 null 或省略：审批时要校验"文件在提案创建后有没有变过"。
 * 新增文件的基线是"当时不存在"，用空内容的 hash 表达它，
 * 校验逻辑就能对已存在/新增两种情况用**同一段代码**处理。
 */
export const EMPTY_FILE_SHA256 = createHash('sha256').update('').digest('hex')

/** 计算字符串的 sha256（十六进制全文） */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 读取工作区内某个文件的内容。
 * 不存在时返回 null（而不是抛错）—— 新增文件是合法场景。
 */
export async function readWorkspaceFileOrNull(relativePath: string): Promise<string | null> {
  const root = getWorkspaceRoot()
  let abs: string
  try {
    abs = await resolveWorkspaceFile(root, relativePath)
  } catch (err) {
    // NOT_FOUND 对"新增文件"是正常情况，转成 null；
    // 其它错误（PATH_DENIED / SENSITIVE_FILE_DENIED）必须上抛 —— 那是越界，不是"文件不在"
    if (err instanceof ToolError && err.code === 'NOT_FOUND') return null
    throw err
  }
  try {
    return await readFile(abs, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/**
 * 计算某个文件的基线 hash。
 * 文件不存在时返回 EMPTY_FILE_SHA256（表示"基线为空"）。
 */
export async function hashWorkspaceFile(relativePath: string): Promise<string> {
  const content = await readWorkspaceFileOrNull(relativePath)
  return content === null ? EMPTY_FILE_SHA256 : sha256(content)
}

/**
 * 批量计算基线 hash。计算是否工作区文件路径和对应哈希
 *
 * 返回 Record 而不是 Map：它要写进 Prisma 的 Json 字段，
 * Record 序列化后就是干净的 `{ "路径": "hash" }`。
 */
export async function hashWorkspaceFiles(
  relativePaths: readonly string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const p of relativePaths) {
    out[p] = await hashWorkspaceFile(p)
  }
  return out
}

/**
 * 仓库级 workspaceId。
 *
 * 当前**只读**阶段，没有专用 worktree
 *
 * 所以用「仓库目录名 + 路径 hash」表达"当前 checkout 这个工作区"：
 * 换机器/换目录会得到不同 id，这正是我们要的 —— 提案不能跨工作区复用。
 */
export function workspaceIdForCurrentCheckout(): string {
  const root = path.resolve(getWorkspaceRoot())
  const name = path.basename(root)
  // 取路径 hash 的前 12 位：够区分不同 checkout，又不会长得难读
  const suffix = sha256(root).slice(0, 12)
  return `repo:${name}:${suffix}`
}