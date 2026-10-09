// lib/agent/toolPolicy.ts
//
// 工具策略的**元数据**：名字与权限。
//
// 为什么要独立成文件，而不是放在 tools/index.ts：
//   tools/index.ts 带 'server-only'（它是整个工具链的唯一出口，这是有意的护栏），
//      而 'server-only' 在纯 Node 下抛错 → 测试无法引用它。
//   只读不变量的断言只需要「有哪些工具、权限是什么」，
//      不需要 AI SDK 的 tool() 对象。把元数据独立出来，
//      测试就能在不碰 server-only、不拉 AI SDK 的前提下验证它。
//   这层元数据是**安全声明**，值得让它在最小依赖下可被独立审查。
//
// 注意：本文件**不加** 'server-only'。

export type ToolPermission = 'P0' | 'P1' | 'P2' | 'P3'

export interface ToolMeta {
  name: string
  permission: ToolPermission
  /** 是否需要人工审批（P2/P3 为 true） */
  needsApproval: boolean
  /** 单次调用的输出上限说明，落审计用 */
  outputLimit: string
  /** 超时（毫秒） */
  timeoutMs: number
}

/**
 * 工具注册表元数据。
 *
 * ⚠️ 这是**只读能力**的声明式清单，也是「未批准写入恒为 0」这一不变量的事实来源。
 * 新增任何工具都必须在这里登记 —— tests/agent/readOnlyInvariant.test.ts 的
 * 白名单断言会因此失败，从而强制这次改动被 code review 看见。
 */
export const toolRegistry: ToolMeta[] = [
  { name: 'listDir', permission: 'P0', needsApproval: false, outputLimit: '500 entries', timeoutMs: 10_000 },
  { name: 'readFile', permission: 'P0', needsApproval: false, outputLimit: '200KB / 单文件', timeoutMs: 10_000 },
  { name: 'grep', permission: 'P0', needsApproval: false, outputLimit: '200 matches', timeoutMs: 30_000 },
  { name: 'gitLog', permission: 'P0', needsApproval: false, outputLimit: '50 commits / 200KB', timeoutMs: 15_000 },
  { name: 'gitDiff', permission: 'P0', needsApproval: false, outputLimit: '200KB diff', timeoutMs: 30_000 },
  { name: 'readSensitiveFile', permission: 'P2', needsApproval: true, outputLimit: '50 keys / 200KB', timeoutMs: 10_000 },
]

/** 工具名清单，供测试做白名单断言 */
export const TOOL_NAMES: readonly string[] = toolRegistry.map((t) => t.name)

/**
 * 禁止出现在工具描述里的语义。
 *
 * 为什么用黑名单检查描述：工具描述是**给模型看的**。
 * 如果某个工具的描述里出现 "write" / "execute"，模型会以为自己有写权限，
 * 进而产生"我已经改好了"的幻觉 —— 这正是 product-spec §13 里
 * 「未批准写入恒为 0」要防的事故。
 */
export const FORBIDDEN_TOOL_DESCRIPTION_WORDS = [
  'write', 'edit', 'delete', 'remove', 'create file', 'execute', 'shell', 'command',
] as const