// lib/agent/trace.ts
//
// 工具调用追踪（product-spec §3.3「审计与可追溯」：记录完整工具调用轨迹 ——
// 调了什么工具、参数摘要、结果摘要、耗时，可回放）。
//
// 为什么独立成文件、且**不加** 'server-only'：
//   tools/index.ts 带着 'server-only'（那是有意的出口护栏），而 tools 会被
//   node:test 直接引用。若本文件也带 server-only，测试一引用 tools 就崩。
//   本文件只依赖 node:crypto 与 lib/logging（同构），放这里最合适。
import { createHash } from 'node:crypto'
import { logEvent } from '@/lib/logging'

/**
 * 记录一次工具调用。
 *
 * ⚠️ 隐私纪律：output 存的是**摘要**而不是原文。
 *
 * 为什么不能存原文：工具输出里包含源码片段，也可能包含用户仓库里的
 * 敏感业务逻辑。把原文全量落库，等于在数据库里复制了一份代码——
 * 一旦日志/备份泄露，泄密面比"只读分析"大得多。
 *
 * 所以存：字节数 + 输出 SHA-256 + 前 N 字符的截断摘要。
 * 前者用于成本核算，中间用于验证"同一输入的输出是否变了"，后者用于人眼排查。
 */
export interface ToolCallTrace {
  /**
   * 追踪 id —— 日志与验收用的对外标识。
   *
   * 与 `runId` 当前同值。保留两个字段是为了语义分开：
   *   - traceId：**验收与回放**用的标识（日志里就叫 traceId）
   *   - runId：  AgentRun 落库后的外键（Day 22–25）
   * AgentRun 未落库时一次 run 就是一次请求，所以两者相等；
   * 将来支持跨请求编排时 traceId 会独立于 requestId，而 runId 不变。
   */
  traceId: string
  runId: string
  toolName: string
  input: unknown          // 参数含路径等，属于审计必需，保留全文
  ok: boolean
  code?: string           // 失败时的错误码
  outputBytes: number
  outputHash: string
  outputPreview: string   // 截断到 200 字符
  durationMs: number
}

/** 预览保留的字符数。足够人眼判断"读到了什么类型的内容" */
export const TRACE_PREVIEW_CHARS = 200

/** 参数落库前的字符上限，防止超长 input 撑爆记录 */
export const TRACE_INPUT_CHARS = 2000

/**
 * 结果 → 可落库的摘要。
 *
 * 单独抽出来是为了让调用方（guardTool）保持简洁，
 * 同时让"如何摘要"这件事只有一处实现、可被单测覆盖。
 */
export function summarizeOutput(result: unknown): {
  outputBytes: number
  outputHash: string
  outputPreview: string
} {
  let serialized: string
  try {
    serialized = JSON.stringify(result) ?? ''
  } catch {
    // 循环引用等不可序列化的情况：退化成 String()，
    // 绝不让"追踪"本身把工具调用搞失败
    serialized = String(result)
  }

  return {
    // 用字节数而不是 length：UTF-16 码元数会把中文低估约 3 倍
    outputBytes: Buffer.byteLength(serialized, 'utf8'),
    // 取前 16 位十六进制即可：用途是"比对是否变化"，不是防篡改
    outputHash: createHash('sha256').update(serialized).digest('hex').slice(0, 16),
    outputPreview: serialized.slice(0, TRACE_PREVIEW_CHARS),
  }
}

/** 只算 input 的字节数与键名，不把值铺进日志 */
function describeInput(input: unknown): { inputBytes: number; inputKeys: string | null } {
  let serialized: string
  try {
    serialized = JSON.stringify(input) ?? ''
  } catch {
    return { inputBytes: 0, inputKeys: null }
  }
  return {
    inputBytes: Buffer.byteLength(serialized, 'utf8'),
    inputKeys:
      input && typeof input === 'object' && !Array.isArray(input)
        ? Object.keys(input as Record<string, unknown>).join(',')
        : null,
  }
}

/**
 * 记录一次工具调用。
 *
 * 当前实现写入结构化日志。落库（`ToolCallRecord` 表）需要 runId 与
 * workspaceId 的生命周期管理
 *
 * ⚠️ 同步且**永不抛错**：追踪是旁路，绝不能因为它失败而让工具调用失败。
 */
export function recordToolCall(trace: ToolCallTrace): void {
  try {
    const { inputBytes, inputKeys } = describeInput(trace.input)
    logEvent(trace.ok ? 'info' : 'warn', 'agent.toolCall', {
      // traceId 是**验收与回放**的检索键：`grep '"traceId":"<id>"'` 即可取出
      // 同一次 run 的全部事件（请求日志 + 每一次工具调用）。
      // runId 同时保留：它是 AgentRun 落库后的外键，现在与 traceId 同值。
      traceId: trace.traceId,
      runId: trace.runId,
      tool: trace.toolName,
      ok: trace.ok,
      code: trace.code ?? null,
      durationMs: trace.durationMs,
      inputBytes,
      // 只记键名而不是值：路径类参数的键名足以留证，
      // 而值可能含用户仓库的结构信息，不在日志里铺开
      inputKeys,
      outputBytes: trace.outputBytes,
      // 记 hash 而不是内容：既能核对"同输入是否同输出"，又不泄露内容
      outputHash: trace.outputHash,
    })
  } catch {
    // 追踪失败必须静默 —— 它是旁路
  }
}
