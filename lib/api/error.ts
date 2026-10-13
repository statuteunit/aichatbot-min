// lib/api/errors.ts
import 'server-only'
import { ApiError, UnauthorizedError } from '@/lib/errors'
import { retryableDbErrorCode } from '@/lib/agent/dbRetry'

/** 把异常统一映射为响应体；未预期异常不泄漏内部信息 */
export function toErrorResponse(err: unknown, requestId: string) {
  if (err instanceof UnauthorizedError) {
    return Response.json({ error: 'UNAUTHORIZED', requestId }, { status: 401 })
  }
  if (err instanceof ApiError) {
    return Response.json({ error: err.code, requestId }, { status: err.status })
  }
  // 数据库瞬时故障（P2028 事务超时 / P2024 连接池取连接超时 / P1017 / P1001 / P1002）
  // 必须与「代码 bug」区分开：
  //   · 500 INTERNAL_ERROR 的含义是「我们写错了」，用户重试没有意义；
  //   · 503 SERVICE_UNAVAILABLE 的含义是「下游暂时不可用」，用户/前端应当重试。
  // 之前这两者混在 500 里，导致一次 6.6 秒的事务超时看起来像程序坏了。
  const dbCode = retryableDbErrorCode(err)
  if (dbCode) {
    console.error('[api][db-unavailable]', { requestId, code: dbCode, err })
    return Response.json(
      { error: 'SERVICE_UNAVAILABLE', requestId, retryable: true },
      { status: 503 },
    )
  }
  console.error('[api][unhandled]', { requestId, err })
  return Response.json({ error: 'INTERNAL_ERROR', requestId }, { status: 500 })
}