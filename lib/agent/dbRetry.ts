// lib/agent/dbRetry.ts
/**
 * 数据库瞬时故障的有界重试。
 *
 * 为什么必须有：库在 db.prisma.io，是一次远程往返，单次操作常见 1~3 秒。
 * 一个请求里串行几次读写，遇到网络抖动或连接池排队就会超时
 * （实测 P2028：交互式事务 5000ms 寿命，实际用了 6630ms）。
 * 这类错误「重试一次就好」，不该升级成用户可见的 500。
 *
 * 为什么**不**看 instanceof PrismaClientKnownRequestError：
 *   1. 那会把 @prisma/client 拉进这个文件，破坏「零项目内依赖」；
 *   2. 更实际的：Prisma 在 Next.js 打包后有时是另一个模块实例，
 *      instanceof 会静默失效 —— 表现为「加了重试却从不触发」。
 *   用鸭子类型判 err.code，稳定得多。
 *
 * ⚠️ 只对**幂等**操作使用本函数。本文件的调用点都是 upsert / updateMany，
 *    天然幂等；若将来要用在非幂等写（例如 CREATE 一个带自增前缀的记录），
 *    必须先确认重试不会产生两条记录。
 */

export type RetryableDbErrorCode =
  | 'P2028' // 交互式事务超过寿命（本次事故的错误码）
  | 'P2024' // 从连接池取连接超时
  | 'P1017' // 服务端关闭了连接
  | 'P1001' // 连不上数据库
  | 'P1002' // 连接数据库超时

const RETRYABLE_DB_CODES = new Set<string>([
  'P2028',
  'P2024',
  'P1017',
  'P1001',
  'P1002',
])

/** 包给上层（路由 / 错误映射）判断「这是瞬时故障还是代码 bug」 */
export class RetryableDbError extends Error {
  readonly code: string
  readonly attempts: number

  constructor(code: string, attempts: number, message?: string) {
    super(message ?? `数据库瞬时故障（${code}），已重试 ${attempts} 次仍失败`)
    this.name = 'RetryableDbError'
    this.code = code
    this.attempts = attempts
  }
}

function prismaErrorCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

export function isRetryableDbError(err: unknown): boolean {
  const code = prismaErrorCode(err)
  return code !== null && RETRYABLE_DB_CODES.has(code)
}

export function retryableDbErrorCode(err: unknown): RetryableDbErrorCode | null {
  const code = prismaErrorCode(err)
  return code !== null && RETRYABLE_DB_CODES.has(code) ? (code as RetryableDbErrorCode) : null
}

/**
 * 第 1 次失败后等 120ms，第 2 次失败后等 400ms。
 * 递增而不是固定：瞬时抖动通常几百毫秒内自愈；固定间隔会在
 * 「刚好一直抖动」的场景里把重试次数浪费在同一条时间线上。
 * 总附加等待上限 520ms —— 相对于已经发生的一次 5 秒超时可以忽略。
 */
const RETRY_DELAYS_MS = [120, 400] as const

export interface RetryOptions {
  /** 打日志用，例如 'chat.saveUserMessage' */
  label: string
}

export async function retryTransient<T>(
  operation: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const maxAttempts = RETRY_DELAYS_MS.length + 1

  for (let attempt = 1; ; attempt++) {
    try {
      return await operation()
    } catch (err) {
      const code = retryableDbErrorCode(err)

      // 非瞬时错误（约束冲突、P2002、代码 bug）立刻抛出：
      // 重试它们只会把同一个失败拖成三次、把 500 延后 半秒，
      // 并且掩盖真正的第一个错误。
      if (code === null || attempt >= maxAttempts) {
        if (code !== null) {
          throw new RetryableDbError(code, attempt)
        }
        throw err
      }

      const delayMs = RETRY_DELAYS_MS[attempt - 1] ?? 0
      // 不用 logEvent：本文件要能在纯 node:test 里被引用。
      // console.warn 在开发态可见，字段形状与 lib/logging.ts 保持接近。
      console.warn(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: 'warn',
          event: 'db.retry',
          label: options.label,
          code,
          attempt,
          delayMs,
        }),
      )
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}