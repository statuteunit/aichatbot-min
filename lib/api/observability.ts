// lib/api/observability.ts
import 'server-only'
import { toErrorResponse } from './error'
import { logEvent, newRequestId } from '@/lib/logging'

// 服务端本来就从本文件引日志，这里 re-export 保持现有调用点不用改
export { logEvent, newRequestId }

type RouteArgs = [Request] | [Request, { params?: unknown }]

/**
 * 路由 handler 的形状：前 N 个参数是 Next.js 传的（req / ctx），最后一个是本包装器追加的 requestId。
 *
 * 为什么要包成对象、而不是写成 `withApiLogging(handler, event)`：
 * 元组类型出现在**参数位置**时是逆变的。若签名写成
 *   `withApiLogging<A extends RouteArgs>(handler: (...args: [...A, string]) => ..., event: string)`
 * TS 会从实参反推 A，遇到 `async (req, requestId) => ...` 时无法确定 A 是 `[Request]` 还是
 * `[Request, { params }]`，于是把 requestId 推成 `string | { params?: unknown }`，
 * 两参数写法直接报 TS2345（"Source has 3 element(s) but target allows only 2"）。
 * 改成 `handler` 作为**属性**出现在对象里后，A 的推断有明确的上下文类型，可以正常收敛。
 *
 * 返回的 `(...args: A)` 就是精确的 Next.js 路由签名，所以 `export const GET = withApiLogging(...)`
 * 交给 Next.js 做类型校验时不会退化。
 */
interface ApiHandler<A extends RouteArgs> {
  handler: (...params: [...A, string]) => Promise<Response>
  event: string
}

/**
 * 包裹路由 handler：自动生成 requestId + 计时 + 记录状态码 + 统一异常映射。
 *
 * **参数约定：Next.js 的原始参数原样透传，requestId 只作为最后一个参数追加。**
 *   withApiLogging({ event: 'chats.GET', handler: async (_req, requestId) => {...} })                    // 静态路由
 *   withApiLogging({ event: 'chats.detail.GET', handler: async (_req, { params }, requestId) => {...} }) // 动态段路由
 *
 * 返回的 `(...args: A)` 就是精确的 Next.js 路由签名，所以 `export const GET = withApiLogging(...)`
 * 交给 Next.js 做类型校验时不会退化。
 */
export function withApiLogging<A extends RouteArgs>({ handler, event }: ApiHandler<A>) {
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