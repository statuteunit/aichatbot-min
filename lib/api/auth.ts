import 'server-only'
import { auth } from '@/auth'

/** 统一的会话所有权入口：任何涉及用户数据的路由都必须经过它 */
export async function requireUserId(): Promise<string> {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) {
    throw new UnauthorizedError()
  }
  return userId
}

export class UnauthorizedError extends Error {
  readonly code = 'UNAUTHORIZED'
  constructor() {
    // 继承内置的Error类，并初始化ErrorMessage为UNAUTHORIZED
    super('UNAUTHORIZED')
    this.name = 'UnauthorizedError'
  }
}