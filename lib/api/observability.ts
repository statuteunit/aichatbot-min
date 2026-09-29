// lib/api/observability.ts
import 'server-only'
import { toErrorResponse } from './error'
import { logEvent, newRequestId } from '@/lib/logging'

// 服务端本来就从本文件引日志，这里 re-export 保持现有调用点不用改
export { logEvent, newRequestId }

type RouteArgs = [Request] | [Request, { params?: unknown }]

/**
 * 包裹路由 handler：自动生成 requestId + 计时 + 记录状态码 + 统一异常映射。
 *
 * **参数约定：Next.js 的原始参数原样透传，requestId 只作为最后一个参数追加。**
 *   withApiLogging(async (req, requestId) => {...})              // 静态路由
 *   withApiLogging(async (req, { params }, requestId) => {...})  // 动态段路由
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