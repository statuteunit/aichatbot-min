import 'server-only'

/**
 * 单实例内存令牌桶限流。
 *
 * 必须说清楚它**不是**分布式限流：多副本部署下每个实例各有一份桶，
 * 真实上限是 N × capacity。V1 用它挡住「单人把免费额度打满」这类事故，
 * 而不是当安全边界用。要严格限流必须换 Redis/Upstash。
 *
 * 为什么不做定时清理：桶按 userId 增长，而本项目用户数是个位数。
 * 加清理任务会引入一个「清理逻辑自己出 bug」的失败面，得不偿失。
 */
const BUCKETS = new Map<string, { tokens: number; updatedAt: number }>()

export function takeToken(
  key: string,
  opts: { capacity: number; refillPerSecond: number },
): boolean {
  const now = Date.now()
  const bucket = BUCKETS.get(key) ?? { tokens: opts.capacity, updatedAt: now }

  // 惰性补充：读的时候按流逝时间补，不做定时器
  const refill = ((now - bucket.updatedAt) / 1000) * opts.refillPerSecond
  bucket.tokens = Math.min(opts.capacity, bucket.tokens + refill)
  bucket.updatedAt = now

  if (bucket.tokens < 1) {
    BUCKETS.set(key, bucket)
    return false
  }
  bucket.tokens -= 1
  BUCKETS.set(key, bucket)
  return true
}