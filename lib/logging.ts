type Level = 'info' | 'warn' | 'error'

/** 生成请求关联 ID。优先 Web Crypto，服务端与浏览器都有。 */
export function newRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 生成 Agent 追踪 id，并给出"如何重建这条 trace"的查询条件。
 *
 * 为什么返回对象而不是裸字符串：光有一个 id 落在日志里**无法验收** ——
 * 验收要的是"能按这个 id 把同一次 run 的全部事件捞出来"。所以这里同时
 * 给出它真实出现的字段名，验收脚本照抄即可，不必去看日志实现。
 *
 * 为什么 traceId 与 requestId 取同一个值：
 *   AgentRun 尚未落库（属 Day 22–25），当前一次 run 就等于一次请求。
 *   两者相等是事实陈述，不是巧合 —— 将来 AgentRun 支持跨请求编排时，
 *   traceId 会独立于 requestId，届时只改本函数，调用方不用动。
 */
export function newTraceContext(): {
  traceId: string
  requestId: string
  /** traceId 在日志里出现的字段名 */
  traceField: 'traceId'
} {
  const id = newRequestId()
  return { traceId: id, requestId: id, traceField: 'traceId' }
}

/**
 * 结构化日志。纪律：只记 id / 状态 / 计数 / 耗时，
 * 禁止记录消息内容与文件内容（日志不能成为泄密面）。
 */
export function logEvent(level: Level, event: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}