// lib/api/observability.ts
import { randomUUID } from 'node:crypto'
import { toErrorResponse } from './error'

type Level = 'info' | 'warn' | 'error'

export function newRequestId() {
  return randomUUID()
}

export function logEvent(level: Level, event: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

/**
 * Next.js 传给路由 handler 的参数：
 *   静态路由`(req)` 动态段路由 `(req, { params })`
 * 注意第二个参数是**路由上下文**（含 params），不是 res —— App Router 没有 res 参数，
 * 响应对象是 handler `return` 出去的那个 Response。
 * 参见 app/api/chats/[id]/route.ts 里对第二个参数解构 `{ params }` 的用法。
 */
type RouteArgs = [Request] | [Request, { params?: unknown }]

/**
 * 包裹路由 handler：自动生成 requestId + 计时 + 记录状态码 + 统一异常映射。
 *
 * **参数约定：Next.js 的原始参数原样透传，requestId 只作为最后一个参数追加。**
 *   withApiLogging(async (req, requestId) => {...})                      // 静态路由
 *   withApiLogging(async (req, { params }, requestId) => {...})          // 动态段路由
 *
 * 为什么不把 requestId 放第一位：那样 handler 的第一个形参会收到真正的 NextRequest，
 * 而本次追加的 requestId 又会被挤到后面，`req.json()` 就成了「字符串调 .json()」。
 */
export function withApiLogging<A extends RouteArgs>(
  handler: (...args: [...A, string]) => Promise<Response>,
  event: string,
) {
  return (...args: A): Promise<Response> => {
    const requestId = newRequestId()
    const startedAt = Date.now()
    const done = (status: number) =>
      logEvent(status >= 500 ? 'error' : 'info', event, {
        requestId,
        status,
        durationMs: Date.now() - startedAt,
      })

    return (async () => {
      try {
        const res = await handler(...args, requestId)
        done(res.status)
        return res
      } catch (err) {
        const res = toErrorResponse(err, requestId)
        logEvent('error', event, {
          requestId,
          status: res.status,
          durationMs: Date.now() - startedAt,
          err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        })
        return res
      }
    })()
  }
}