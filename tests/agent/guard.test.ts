// tests/agent/guard.test.ts
//
// guard 是纯逻辑，且它的正确性完全取决于"同一参数"的判定是否稳定。
// 如果 stableStringify 不稳定，去重就会静默失效——不报错、只是不生效，
// 这类 bug 只能靠测试发现。
import assert from 'node:assert/strict'
import test from 'node:test'
import { createCallGuard } from '../../lib/agent/guard'

test('允许前 N 次相同调用，第 N+1 次拦截', () => {
  const guard = createCallGuard({ maxSameCall: 2 })
  assert.equal(guard.check('grep', { pattern: 'foo' }), null)
  assert.equal(guard.check('grep', { pattern: 'foo' }), null)

  const rejected = guard.check('grep', { pattern: 'foo' })
  assert.ok(rejected, '第 3 次应当被拦截')
  assert.equal(rejected.code, 'CALL_LIMIT_EXCEEDED')
  assert.ok(rejected.hint.length > 0, '必须给出行动指引，否则模型会重试')
})

test('键顺序不影响"同一参数"的判定', () => {
  const guard = createCallGuard({ maxSameCall: 1 })
  assert.equal(guard.check('readFile', { path: 'a.ts', startLine: 1 }), null)
  // 同样内容、不同键顺序 → 应视为同一个调用
  const rejected = guard.check('readFile', { startLine: 1, path: 'a.ts' })
  assert.ok(rejected, '键顺序不同不应绕过去重')
  assert.equal(rejected.code, 'CALL_LIMIT_EXCEEDED')
})

test('不同参数各自计数，互不影响', () => {
  const guard = createCallGuard({ maxSameCall: 1 })
  assert.equal(guard.check('readFile', { path: 'a.ts' }), null)
  assert.equal(guard.check('readFile', { path: 'b.ts' }), null)
  assert.equal(guard.check('grep', { pattern: 'x' }), null)
})

test('数组顺序不同视为不同调用（顺序有语义）', () => {
  const guard = createCallGuard({ maxSameCall: 1 })
  assert.equal(guard.check('t', { args: [1, 2] }), null)
  assert.equal(guard.check('t', { args: [2, 1] }), null, '数组顺序不同应各自计数')
})

test('读取文件数超过上限时拦截', () => {
  const guard = createCallGuard({ maxFilesRead: 2, maxSameCall: 10 })
  assert.equal(guard.check('readFile', { path: 'a.ts' }), null)
  assert.equal(guard.check('readFile', { path: 'b.ts' }), null)

  const rejected = guard.check('readFile', { path: 'c.ts' })
  assert.ok(rejected, '第 3 个不同文件应触发预算上限')
  assert.equal(rejected.code, 'FILE_BUDGET_EXCEEDED')
})

test('重复读同一个文件不消耗预算', () => {
  const guard = createCallGuard({ maxFilesRead: 1, maxSameCall: 10 })
  assert.equal(guard.check('readFile', { path: 'a.ts' }), null)
  // 同一个路径，两次调用仍只算一个文件
  assert.equal(guard.check('readFile', { path: 'a.ts' }), null)
  assert.equal(guard.filesReadCount(), 1)
})

test('非读取类工具不计入文件预算', () => {
  const guard = createCallGuard({ maxFilesRead: 1, maxSameCall: 10 })
  assert.equal(guard.check('grep', { pattern: 'a' }), null)
  assert.equal(guard.check('gitLog', { limit: 5 }), null)
  assert.equal(guard.filesReadCount(), 0)
})

test('readSensitiveFile 不受文件预算限制', () => {
  // 它需要用户逐次批准，若因"预算"被自动拒绝，会出现
  // 「用户刚点批准却被告知预算不够」的荒谬情形
  const guard = createCallGuard({ maxFilesRead: 1, maxSameCall: 10 })
  for (let i = 0; i < 5; i += 1) {
    const result = guard.check('readSensitiveFile', { path: `.env.${i}` })
    assert.equal(result, null, `第 ${i + 1} 次 readSensitiveFile 不应被拦截`)
  }
})

test('totalCalls 统计所有检查过的调用', () => {
  const guard = createCallGuard({ maxSameCall: 1 })
  guard.check('grep', { pattern: 'a' })
  guard.check('grep', { pattern: 'a' })
  assert.equal(guard.totalCalls(), 2)
})

test('不同的 guard 实例互不共享状态（跨请求隔离）', () => {
  const first = createCallGuard({ maxSameCall: 1 })
  assert.equal(first.check('grep', { pattern: 'a' }), null)
  assert.ok(first.check('grep', { pattern: 'a' }))

  // 新实例必须是从零开始的
  const second = createCallGuard({ maxSameCall: 1 })
  assert.equal(second.check('grep', { pattern: 'a' }), null, '新 guard 不应继承上一个实例的计数')
})

test('null / undefined / 原始值参数不会抛错', () => {
  const guard = createCallGuard({ maxSameCall: 1 })
  assert.equal(guard.check('t', null), null)
  assert.equal(guard.check('t', undefined), null)
  assert.equal(guard.check('t', 42), null)
  assert.equal(guard.check('t', 'text'), null)
})

test('readFile 缺少 path 时不计入预算也不抛错', () => {
  const guard = createCallGuard({ maxFilesRead: 1 })
  assert.equal(guard.check('readFile', {}), null)
  assert.equal(guard.check('readFile', null), null)
  assert.equal(guard.filesReadCount(), 0)
})
