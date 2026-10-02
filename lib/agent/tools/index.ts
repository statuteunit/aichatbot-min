// lib/agent/tools/index.ts
//
// 本文件是 Agent 工具对外的**唯一出口**，也是整条工具链上唯一声明 'server-only' 的地方。
//
// 为什么护栏集中在这里：
//   listDir / readFile / grep / security 都需要能被 node:test 直接单测，而 'server-only'
//   在纯 Node 环境下会抛错（它不是 Next.js 的 react-server 条件），导致测试无法运行。
//   把它们隔离在「测试不引用的出口文件」之外，就能同时满足两件事：
//     ① 任何客户端组件引用 agentTools → Next.js 构建期直接失败（护栏生效）
//     ② 工具实现仍可被单测覆盖（护栏不挡测试）
//   代价：直接 import ./listDir 等子模块可以绕过护栏。**不要那样做**，一律从本文件引入。
import 'server-only'
import { tool } from 'ai'
import { ListDirInputSchema, listDir } from './listDir'
import { ReadFileInputSchema, readFileTool } from './readFile'
import { GrepInputSchema, grepTool } from './grep'

/**
 * P0 读取 = 自动执行；P1 提案 = 自动执行但不写盘；P2 编辑 / P3 验证 = 必须人工批准
 */
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

/** 注册表元数据 */
export const toolRegistry: ToolMeta[] = [
  { name: 'listDir', permission: 'P0', needsApproval: false, outputLimit: '500 entries', timeoutMs: 10_000 },
  { name: 'readFile', permission: 'P0', needsApproval: false, outputLimit: '200KB / 单文件', timeoutMs: 10_000 },
  { name: 'grep', permission: 'P0', needsApproval: false, outputLimit: '200 matches', timeoutMs: 30_000 },
]

/**
 * 交给模型的工具集。
 *
 * 注意 inputSchema 用普通 z.object，**不要 .strict()**：
 * z.object 转 JSON Schema 本来就带 additionalProperties:false，部分 provider 会拒绝。
 * 输入校验由 AI SDK 在 execute 之前完成。
 */
export const agentTools = {
  listDir: tool({
    description:
      '列出工作区目录结构。用于先建立代码地图。会忽略 node_modules/.next/.git 等目录。',
    inputSchema: ListDirInputSchema,
    execute: async (input) => listDir(input),
  }),

  readFile: tool({
    description:
      '读取工作区内某个文件的内容，支持行号区间。返回内容每行带行号前缀，可直接用于引用 file:line 证据。',
    inputSchema: ReadFileInputSchema,
    execute: async (input) => readFileTool(input),
  }),

  grep: tool({
    description:
      '在工作区内按正则检索代码，返回 file:line 与匹配行。定位实现时优先用它，再用 readFile 精读命中位置。',
    inputSchema: GrepInputSchema,
    execute: async (input) => grepTool(input),
  }),
}

export type AgentTools = typeof agentTools