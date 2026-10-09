// lib/api/observability.ts
import 'server-only'
import { toErrorResponse } from './error'
import { logEvent, newTraceContext } from '@/lib/logging'

// 服务端本来就从本文件引日志，这里 re-export 保持现有调用点不用改
export { logEvent, newRequestId } from '@/lib/logging'
export { newTraceContext } from '@/lib/logging'

/**
 * 从请求的 requestId 派生出 trace 字段，供 handler 里的其它日志复用。
 *
 * 为什么需要它：工具调用的追踪日志（agent.toolCall）与主请求日志
 * （chat.POST / chat.finish）必须带**同一个 traceId**，否则无法按 trace 回放
 * （product-spec §3.3「可按 run 回放」）。
 * 如果各处自己生成 id，它们就会各不相同 —— trace 直接断掉。
 *
 * ⚠️ traceId 与 requestId 当前同值：AgentRun 未落库（Day 22–25），
 *    一次 run 就是一次请求。字段**分开命名**是为了将来 AgentRun 支持
 *    跨请求编排时无需改动下游（那时 traceId 会独立于 requestId）。
 */
export function traceFields(requestId: string): { traceId: string; requestId: string } {
  return { traceId: requestId, requestId }
}

/** 挂在 Request 上承载 requestId 的 Symbol —— 不会与 Request 自有属性冲突 */
const REQUEST_ID_KEY = Symbol.for('dsh.apiRequestId')

/**
 * 从 Request 上取回 requestId。
 *
 * 为什么不再用「最后一个位置参数」传它：
 *   原实现是 `handler(...args, requestId)`。这在**静态路由**下没问题
 *   （args = [req]，requestId 落在第 2 位），但一旦 args 变成
 *   [req, ctx]，requestId 就被顶到第 3 位 —— 而静态路由的 handler 只声明了
 *   2 个形参，于是它的第 2 个形参拿到的是 **ctx 对象**，真正的 requestId 被丢弃。
 *   症状：日志里 `"requestId":{}`，且**类型检查抓不到**（多余实参在 TS 里合法）。
 *
 *   改用 Request 承载后，requestId 的位置与 args 的形状**完全解耦** ——
 *   Request 恒为第 1 个参数，无论静态还是动态路由。
 */
export function getRequestId(req: Request): string {
  const id = (req as Request & { [REQUEST_ID_KEY]?: string })[REQUEST_ID_KEY]
  if (typeof id !== 'string' || id.length === 0) {
    // 兜底而不是抛错：日志/trace 不该让请求失败。
    // 真走到这里说明 handler 没有被 withApiLogging 包装，是个接线错误。
    return 'no-request-id'
  }
  return id
}

type RouteArgs = [Request] | [Request, { params?: unknown }]

/**
 * 路由 handler 的形状：**Next.js 传的参数原样透传，requestId 通过 Request 载体读取**。
 *
 * 为什么要包成对象、而不是写成 `withApiLogging(handler, event)`：
 * 元组类型出现在**参数位置**时是逆变的。若签名写成
 *   `withApiLogging<A extends RouteArgs>(handler: (...args: A) => ..., event: string)`
 * TS 会从实参反推 A，遇到 `async (req, _ctx) => ...` 时无法确定 A 是
 * `[Request]` 还是 `[Request, { params }]`，于是把 ctx 推成联合类型，
 * 两种写法都会报 TS2345。改成 `handler` 作为**属性**出现在对象里后，
 * A 的推断有明确的上下文类型，可以正常收敛。
 */
interface ApiHandler<A extends RouteArgs> {
  handler: (...params: A) => Promise<Response>
  event: string
}

/**
 * 包裹路由 handler：自动生成 traceId/requestId + 计时 + 记录状态码 + 统一异常映射。
 *
 * **参数约定：Next.js 的原始参数原样透传，requestId 挂到 Request 上，用 getRequestId(req) 取。**
 *   withApiLogging({ event: 'chats.GET', handler: async (req) => { const id = getRequestId(req) } })                  // 静态路由
 *   withApiLogging({ event: 'chats.detail.GET', handler: async (req, { params }) => {...} })                          // 动态段路由
 *
 * 返回的 `(...args: A)` 就是精确的 Next.js 路由签名，所以 `export const GET = withApiLogging(...)`
 * 交给 Next.js 做类型校验时不会退化。
 */
export function withApiLogging<A extends RouteArgs>({ handler, event }: ApiHandler<A>) {
  return (...args: A): Promise<Response> => {
    // 用 newTraceContext() 而不是 newRequestId()：它返回 { traceId, requestId }，
    // 且两者当前同值。这样"请求日志"与"工具追踪日志"天然带同一个 traceId。
    const { traceId, requestId } = newTraceContext()
    const startedAt = Date.now()

    // 把 requestId 挂到 Request 上。Request 是 args[0] 且恒存在
    // （RouteArgs 的第一项一定是 Request）。
    const req = args[0]
    try {
      Object.defineProperty(req, REQUEST_ID_KEY, {
        value: requestId,
        enumerable: false,
        configurable: true,
        writable: false,
      })
    } catch {
      // 某些运行时下 Request 可能被冻结。此时 getRequestId 会退化为兜底值，
      // 请求本身仍然正常 —— 日志缺 id 不能演变成请求失败。
    }

    const done = (status: number) =>
      logEvent(status >= 500 ? 'error' : 'info', event, {
        traceId,
        requestId,
        status,
        durationMs: Date.now() - startedAt,
      })

    return (async () => {
      try {
        const res = await handler(...args)
        done(res.status)
        return res
      } catch (err) {
        const res = toErrorResponse(err, requestId)
        logEvent('error', event, {
          traceId,
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
