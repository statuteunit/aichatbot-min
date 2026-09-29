import 'server-only'
import { auth } from '@/auth'
// 错误类定义在同构模块里，这里只 import + re-export，
// 避免客户端为了拿一个错误类而被迫引入本文件（本文件是 server-only）
import { UnauthorizedError } from '@/lib/errors'

export { UnauthorizedError }

/** 统一的会话所有权入口：任何涉及用户数据的路由都必须经过它 */
export async function requireUserId(): Promise<string> {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) {
    throw new UnauthorizedError()
  }
  return userId
}