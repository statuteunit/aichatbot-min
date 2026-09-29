type Level = 'info' | 'warn' | 'error'

/** 生成请求关联 ID。优先 Web Crypto，服务端与浏览器都有。 */
export function newRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
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