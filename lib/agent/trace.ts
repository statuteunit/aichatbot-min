// lib/agent/trace.ts
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