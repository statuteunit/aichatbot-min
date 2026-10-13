// lib/agent/runContext.ts
//
// 每请求的 Agent 上下文。
//
// 为什么需要它：AI SDK 的 `tool()` 是**模块级**对象，`execute` 的签名由 SDK 固定，
// 拿不到 traceId / runId / userId 这些"每请求"的值。
// 所以用一个模块作用域载体，在每次请求开始时设置。
//
// ⚠️ 已知弱点：并发请求会共享这一个模块实例。Node 的模块缓存是每进程一份，
//    两个并发请求可能互相覆盖。V1 接受这个弱点并在此记录 ——
//    更稳的做法是 AsyncLocalStorage，但那会给所有工具增加一层包装。
//    当前风险的实际边界：最坏情况是"用户 A 的提案被记到用户 B 的 runId 下"，
//    而 apply.ts 仍然按 (proposalId, userId) 双重校验，**不会越权写盘**。
export interface AgentRequestContext {
  traceId: string
  runId: string
  userId: string
  /**
   * 本次请求针对的会话 id。
   *
   * 用途：createPatchProposal 在发现 runId 不可用时要**自建** AgentRun，
   * 而建 run 需要 chatId（外键 + 归属校验都靠它）。
   * 新会话（客户端没带 chatId）时为 null —— 那种情况下提案本来就不该被创建，
   * 因为还没有任何一行 Chat 可供归属。
   */
  chatId: string | null
  /** 触发本次 run 的助手消息 id；本阶段尚未持久化时为 null */
  messageId: string | null
}

let context: AgentRequestContext = {
  traceId: 'no-trace',
  runId: 'no-run',
  userId: '',
  chatId: null,
  messageId: null,
}

/**
 * ⚠️ 这是**合并**而不是替换：没传的字段会保留上一次请求的值。
 *
 * 后果是具体的：如果某次请求只传了 { userId }，它的 chatId 会继承**上一个请求**的会话，
 * 于是提案被建到别人的会话下。所以调用方必须把五个字段**全部显式传一遍**
 * （app/api/chat/route.ts 是唯一调用点，那里已经这么做了）。
 *
 * 更彻底的修法是换成 AsyncLocalStorage（见文件头"已知弱点"），
 * 但那是独立一次改动；在那之前，这条约定是防止串台的关键。
 */
export function setAgentRequestContext(next: Partial<AgentRequestContext>): void {
  context = { ...context, ...next }
}

export function getAgentRequestContext(): AgentRequestContext {
  return context
}

/** 便捷读取：只关心 userId 的调用方（如 applyApprovedPatch）用这个 */
export function getCurrentUserId(): string {
  return context.userId
}

/**
 * 便捷读取：需要为本次请求补建 AgentRun 的调用方（createPatchProposal）用这个。
 * 新会话没有 chatId 时返回空字符串 —— 调用方据此拒绝，而不是拿一个空 id 去建 run。
 */
export function getCurrentChatId(): string {
  return context.chatId ?? ''
}

/** 便捷读取：把建 run 的 traceId 与本次请求日志串在同一条 trace 上 */
export function getCurrentTraceId(): string {
  return context.traceId
}