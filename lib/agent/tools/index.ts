// lib/agent/tools/index.ts
//
// 本文件是 Agent 工具对外的**唯一出口**，也是整条工具链上唯一声明 'server-only' 的地方。
//
// 为什么护栏集中在这里：
//   listDir / readFile / grep / gitLog / gitDiff / security 都需要能被 node:test 直接单测，
//   而 'server-only' 在纯 Node 环境下会抛错（它不是 Next.js 的 react-server 条件），
//   导致测试无法运行。把它们隔离在「测试不引用的出口文件」之外，就能同时满足两件事：
//     ① 任何客户端组件引用 agentTools → Next.js 构建期直接失败（护栏生效）
//     ② 工具实现仍可被单测覆盖（护栏不挡测试）
//   代价：直接 import ./listDir 等子模块可以绕过护栏。**不要那样做**，一律从本文件引入。
import 'server-only'
import { tool } from 'ai'
import { createCallGuard, type CallGuard, type CallRejection } from '../guard'
import { recordToolCall, summarizeOutput } from '../trace'
import { ListDirInputSchema, listDir } from './listDir'
import { ReadFileInputSchema, readFileTool } from './readFile'
import { GrepInputSchema, grepTool } from './grep'
import { GitLogInputSchema, gitLog } from './gitLog'
import { GitDiffInputSchema, gitDiff } from './gitDiff'
import { readSensitiveFileTool } from './readSensitiveFile'

/*
 * 基础工具定义（不带 guard）。
 *
 * 注意 inputSchema 用普通 z.object，**不要 .strict()**：
 * z.object 转 JSON Schema 本来就带 additionalProperties:false，部分 provider 会拒绝。
 * 输入校验由 AI SDK 在 execute 之前完成。
 */
export const baseTools = {
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

  gitLog: tool({
    description:
      '查看最近的 git 提交历史（hash / 作者 / 日期 / 标题），可限定到某个文件或目录。' +
      '用于判断某段代码是什么时候、因何被改动。仓库还没有提交时返回 EMPTY_REPO，不是错误。',
    inputSchema: GitLogInputSchema,
    execute: async (input) => gitLog(input),
  }),

  gitDiff: tool({
    description:
      '查看改动内容（unified diff + 每个文件的行数统计）。不给 base 时显示工作区未提交的改动；' +
      '同时给 base 与 target 时显示两个 ref 之间的差异。用于确认"当前现状"而不是猜测。',
    inputSchema: GitDiffInputSchema,
    execute: async (input) => gitDiff(input),
  }),

  // 直接复用 readSensitiveFile.ts 里的定义：
  // 它自带 needsApproval: true，不需要在这里重复声明。
  readSensitiveFile: readSensitiveFileTool,
}

/**
 * 把一次调用包上 guard。
 *
 * 拦截时不抛异常，而是返回与其它工具同形的 `{ ok: false, code, message }`
 * 并附带行动指引：
 *   ① 抛出异常在 SDK 侧会被记成工具执行失败，模型分不清"被限制"与"出故障"；
 *   ② 现有所有工具都返回 ok/code 结构，模型已经会读它；
 *   ③ 必须给 hint，否则模型大概率会重试同一个调用。
 */
function guardTool<T extends { execute?: (...args: never[]) => unknown }>(
  name: string,
  base: T,
  guard: CallGuard,
  traceId: string,
): T {
  const baseExecute = base.execute
  if (typeof baseExecute !== 'function') return base

  return {
    ...base,
    execute: async (input: unknown, ...rest: unknown[]) => {
      const rejection: CallRejection | null = guard.check(name, input)
      if (rejection) {
        // 被 guard 拦截也算一次"工具调用事件"，值得留痕：
        // 否则审计轨迹里会缺少"模型尝试了什么但被拒"这一段。
        recordToolCall({
          traceId,
          runId: traceId,
          toolName: name,
          input,
          ok: false,
          code: rejection.code,
          durationMs: 0,
          outputBytes: 0,
          outputHash: '',
          outputPreview: rejection.hint,
        })
        return {
          ok: false,
          code: rejection.code,
          message: rejection.message,
          hint: rejection.hint,
        }
      }

      // ⚠️ 计时与追踪必须在 execute 回调**内部**：
      // input / rest 只在这个作用域里存在。放到函数体顶层会引用到不存在的变量
      const startedAt = Date.now()
      const result = await (baseExecute as (i: unknown, ...r: unknown[]) => unknown)(input, ...rest)
      const durationMs = Date.now() - startedAt

      // 执行完成后回报实际输出体积，供字节预算累计。
      // 用 JSON 长度近似即可 —— 不需要精确到 token，
      // 目的是拦住"读了几个超大文件把上下文烧光"这种情况。
      try {
        guard.report(name, JSON.stringify(result)?.length ?? 0)
      } catch {
        // 结果不可序列化（理论上不会）时忽略，绝不能因此让工具调用失败
      }

      // 追踪是旁路：recordToolCall 自己兜住异常，失败也不影响工具返回。
      const summary = summarizeOutput(result)
      recordToolCall({
        traceId,
        runId: traceId,
        toolName: name,
        input,
        // 工具的返回体统一是 { ok: boolean }，没有 ok 字段时视为成功
        ok: (result as { ok?: boolean } | null)?.ok ?? true,
        code: (result as { code?: string } | null)?.code,
        durationMs,
        ...summary,
      })

      return result
    },
  } as T
}

/**
 * 按请求创建带 guard 的工具集。
 *
 * 注意：app/api/chat 必须用这个，不要用下面的 agentTools ——
 * guard 的计数是"单次分析"语义，共享一份会把不同用户的预算混在一起。
 *
 * @param traceId 追踪 id。**传入 requestId**（或 traceFields(requestId).traceId）
 *                即可让请求日志与每一次工具调用带同一个 traceId，从而按 trace 回放。
 *                省略时退化为 'no-trace'（仅测试/探针场景）。
 */
export function createAgentTools(guard: CallGuard, traceId = 'no-trace') {
  return {
    listDir: guardTool('listDir', baseTools.listDir, guard, traceId),
    readFile: guardTool('readFile', baseTools.readFile, guard, traceId),
    grep: guardTool('grep', baseTools.grep, guard, traceId),
    gitLog: guardTool('gitLog', baseTools.gitLog, guard, traceId),
    gitDiff: guardTool('gitDiff', baseTools.gitDiff, guard, traceId),
    readSensitiveFile: guardTool('readSensitiveFile', baseTools.readSensitiveFile, guard, traceId),
  }
}

/** 便捷入口：每请求一个新的 guard */
export function createGuardedAgentTools(traceId = 'no-trace') {
  return createAgentTools(createCallGuard(), traceId)
}

/**
 * 不带 guard 的工具集。
 * 仅用于测试与「不需要预算约束」的场景（如 dev 探针）。
 * 生产路径请用 createGuardedAgentTools()。
 */
export const agentTools = baseTools

export type AgentTools = typeof agentTools