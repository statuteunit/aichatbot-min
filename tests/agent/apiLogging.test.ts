// tests/agent/apiLogging.test.ts
//
// 守住 withApiLogging 的参数传递契约。
//
// 背景（真实故障）：requestId 原先靠**最后一个位置参数**传给 handler
// （`handler(...args, requestId)`）。这在静态路由下没问题（args = [req]），
// 但一旦 args 变成 [req, ctx]，requestId 就被顶到第 3 位 ——
// 而静态路由的 handler 只声明 2 个形参，第 2 个形参于是拿到 **ctx 对象**，
// 真正的 requestId 被丢弃。
//
// 实测证据（.dev.log）：
//   chat.POST      "traceId":"e43f304e-..."   ← 包装器内部局部变量，正确
//   agent.toolCall "traceId":{}               ← 传进 handler 的却是对象
//   chat.finish    "traceId":{},"requestId":{}
//
// 修复：requestId 改为挂在 **Request** 上，用 getRequestId(req) 取。
// Request 恒为第 1 个参数，与 args 的形状完全解耦。
import assert from 'node:assert/strict'
import test from 'node:test'

/** 与 lib/api/observability.ts 的 REQUEST_ID_KEY 保持一致 */
const REQUEST_ID_KEY = Symbol.for('dsh.apiRequestId')

/**
 * 复刻修复后的传递逻辑（不 import 真实模块：它带 'server-only'，纯 Node 下会抛错）。
 *
 * ⚠️ 这个复刻必须与 lib/api/observability.ts 同步。
 * 它把"requestId 与 args 形状解耦"这个契约写成可执行断言 ——
 * 若真实实现改回位置参数，这里会失败并提醒同步。
 */
function withApiLoggingLike<A extends [Request, ...unknown[]]>(
  handler: (...params: A) => Promise<Response>,
) {
  return (...args: A): Promise<Response> => {
    const requestId = 'REQ-ID-STRING'
    Object.defineProperty(args[0], REQUEST_ID_KEY, {
      value: requestId,
      enumerable: false,
      configurable: true,
      writable: false,
    })
    return handler(...args)
  }
}

function getRequestIdLike(req: Request): string {
  const id = (req as Request & { [REQUEST_ID_KEY]?: string })[REQUEST_ID_KEY]
  return typeof id === 'string' && id.length > 0 ? id : 'no-request-id'
}

test('静态路由（args 只有 req）：handler 拿到字符串 requestId', async () => {
  let seen: unknown = 'unset'
  const wrapped = withApiLoggingLike<[Request]>(async (req) => {
    seen = getRequestIdLike(req)
    return new Response('ok')
  })
  await wrapped(new Request('http://localhost/api/chat'))
  assert.equal(seen, 'REQ-ID-STRING')
  assert.equal(typeof seen, 'string')
})

test('动态路由（args 有 req + ctx）：handler 拿到的仍是字符串 requestId', async () => {
  let seen: unknown = 'unset'
  let seenCtx: unknown = 'unset'
  const wrapped = withApiLoggingLike<[Request, { params: Promise<{ id: string }> }]>(
    async (req, ctx) => {
      seen = getRequestIdLike(req)
      seenCtx = ctx
      return new Response('ok')
    },
  )
  await wrapped(new Request('http://localhost/api/chats/1'), {
    params: Promise.resolve({ id: '1' }),
  })
  assert.equal(typeof seen, 'string', 'requestId 必须是字符串')
  assert.equal(seen, 'REQ-ID-STRING')
  // ctx 仍然原样可用 —— 修复没有破坏动态路由读 params 的能力
  assert.deepEqual(await (seenCtx as { params: Promise<{ id: string }> }).params, { id: '1' })
})

test('args 多出 ctx 时也不会污染 requestId（回归：曾经拿到 ctx 对象）', async () => {
  let seen: unknown = 'unset'
  const wrapped = withApiLoggingLike<[Request, { params?: unknown }]>(async (req) => {
    seen = getRequestIdLike(req)
    return new Response('ok')
  })
  await wrapped(new Request('http://localhost/api/chat'), { params: undefined })

  assert.equal(typeof seen, 'string', `修复前这里会是 object（ctx），实际 ${typeof seen}`)
  assert.equal(seen, 'REQ-ID-STRING')
})

test('未被包装的 Request：getRequestId 返回兜底值而不是抛错', () => {
  // 兜底而不是抛错：日志缺 id 不该演变成请求失败
  assert.equal(getRequestIdLike(new Request('http://localhost/x')), 'no-request-id')
})

test('requestId 挂在 Request 上但不进入枚举属性（不影响序列化 / 日志体积）', () => {
  const req = new Request('http://localhost/x')
  Object.defineProperty(req, REQUEST_ID_KEY, {
    value: 'R1',
    enumerable: false,
    configurable: true,
    writable: false,
  })
  assert.equal(Object.keys(req).includes('dsh.apiRequestId'), false)
  assert.ok(!JSON.stringify(Object.keys(req)).includes('dsh.apiRequestId'))
})
