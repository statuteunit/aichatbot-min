// lib/api/errors.ts
import { UnauthorizedError } from './auth'

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) {
    super(message ?? code)
  }
}

/** 把异常统一映射为响应体；未预期异常不泄漏内部信息 */
export function toErrorResponse(err: unknown, requestId: string) {
  if (err instanceof UnauthorizedError) {
    return Response.json({ error: 'UNAUTHORIZED', requestId }, { status: 401 })
  }
  if (err instanceof ApiError) {
    return Response.json({ error: err.code, requestId }, { status: err.status })
  }
  console.error('[api][unhandled]', { requestId, err })
  return Response.json({ error: 'INTERNAL_ERROR', requestId }, { status: 500 })
}