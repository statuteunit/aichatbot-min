import { test } from 'node:test'
import assert from 'node:assert/strict'
import { retryTransient, isRetryableDbError, RetryableDbError } from '../../lib/agent/dbRetry'

/** 造一个「像 Prisma 错误」的对象：只有 code 字段，故意不是真的 PrismaClientKnownRequestError */
function prismaLikeError(code: string) {
  const err = new Error(`prisma-like ${code}`) as Error & { code: string }
  err.code = code
  return err
}

test('P2028 第一次失败、第二次成功 → 直接返回结果', async () => {
  let calls = 0
  const result = await retryTransient(async () => {
    calls++
    if (calls === 1) throw prismaLikeError('P2028')
    return 'ok'
  }, { label: 'test' })
  assert.equal(result, 'ok')
  assert.equal(calls, 2, '应当恰好重试一次')
})

test('P2028 连续失败 → 总共尝试 3 次后抛 RetryableDbError', async () => {
  let calls = 0
  await assert.rejects(
    () =>
      retryTransient(async () => {
        calls++
        throw prismaLikeError('P2028')
      }, { label: 'test' }),
    (err: unknown) => {
      assert.ok(err instanceof RetryableDbError)
      assert.equal(err.code, 'P2028')
      assert.equal(err.attempts, 3)
      return true
    },
  )
  assert.equal(calls, 3)
})

test('非瞬时错误（P2002 唯一约束）一次都不重试，原样抛出', async () => {
  let calls = 0
  const boom = prismaLikeError('P2002')
  await assert.rejects(
    () =>
      retryTransient(async () => {
        calls++
        throw boom
      }, { label: 'test' }),
    (err: unknown) => {
      assert.equal(err, boom, '必须是原来那个错误对象，不能被包装成 RetryableDbError')
      return true
    },
  )
  assert.equal(calls, 1, 'P2002 重试多少次都是同样的结果，重试就是浪费')
})

test('完全没有 code 字段的普通异常 → 不重试', async () => {
  let calls = 0
  await assert.rejects(
    () =>
      retryTransient(async () => {
        calls++
        throw new Error('Chat not found')
      }, { label: 'test' }),
  )
  assert.equal(calls, 1)
})

test('isRetryableDbError 识别集合内的码、拒绝集合外的码', () => {
  for (const code of ['P2028', 'P2024', 'P1017', 'P1001', 'P1002']) {
    assert.equal(isRetryableDbError(prismaLikeError(code)), true, `${code} 应可重试`)
  }
  for (const code of ['P2002', 'P2025', 'P1000']) {
    assert.equal(isRetryableDbError(prismaLikeError(code)), false, `${code} 不应重试`)
  }
  assert.equal(isRetryableDbError(new Error('plain')), false)
  assert.equal(isRetryableDbError(null), false)
  assert.equal(isRetryableDbError({ code: 123 }), false, 'code 不是字符串时不能误判')
})