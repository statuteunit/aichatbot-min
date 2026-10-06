// tests/agent/sensitiveFile.test.ts
//
// 守住 inspectSensitiveFilePath 的核心契约：**只返回结构，永不返回值**。
// 这是本仓库唯一一处被明确设计成"可以碰敏感文件"的入口，
// 所以它的边界必须有测试盯住，不能靠注释保证。
//
// 注意：这些用例**不**读取真实仓库的 .env，全部在临时目录构造。
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { inspectSensitiveFilePath, ToolError } from '../../lib/agent/security'

let root: string

const SECRET_VALUE = 'sk-do-not-leak-this-value'
const SECRET_KEY = 'OPENROUTER_API_KEY'

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'agent-sensitive-'))
  await mkdir(path.join(root, 'config'), { recursive: true })
  // 典型的 .env：注释 + 空行 + 引号包裹的值 + 无值的键
  await writeFile(
    path.join(root, '.env'),
    [
      '# 环境变量',
      '',
      `${SECRET_KEY}=${SECRET_VALUE}`,
      `AUTH_SECRET="${SECRET_VALUE}"`,
      'EMPTY_KEY=',
      'PLAIN=1',
      '# 注释行也含 ' + SECRET_VALUE,
      '',
    ].join('\n'),
  )
  await writeFile(path.join(root, 'config', 'server.key'), 'KEY: ' + SECRET_VALUE + '\n')
  await writeFile(path.join(root, 'small.txt'), 'no equals sign here\n')
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

test('返回键名但不包含任何值', async () => {
  const result = await inspectSensitiveFilePath({ workspaceRoot: root, relativePath: '.env' })

  assert.equal(result.exists, true)
  assert.deepEqual(result.keys, [SECRET_KEY, 'AUTH_SECRET', 'EMPTY_KEY', 'PLAIN'])

  // 关键断言：序列化后的结果里不能出现任何值
  const serialized = JSON.stringify(result)
  assert.ok(
    !serialized.includes(SECRET_VALUE),
    `结果里泄漏了敏感值：${serialized}`,
  )
})

test('跳过注释与空行，不把它们当成键', async () => {
  const result = await inspectSensitiveFilePath({ workspaceRoot: root, relativePath: '.env' })
  assert.ok(!result.keys.some((key) => key.startsWith('#')))
  assert.ok(!result.keys.includes(''))
})

test('返回行数与字节数', async () => {
  const result = await inspectSensitiveFilePath({ workspaceRoot: root, relativePath: '.env' })
  assert.ok(result.totalLines > 0)
  assert.ok(result.byteSize > 0)
})

test('不存在的文件返回 exists=false 而不是抛错', async () => {
  const result = await inspectSensitiveFilePath({ workspaceRoot: root, relativePath: '.env.missing' })
  assert.equal(result.exists, false)
  assert.equal(result.totalLines, 0)
  assert.deepEqual(result.keys, [])
})

test('无 = 的文件返回空键名列表', async () => {
  const result = await inspectSensitiveFilePath({ workspaceRoot: root, relativePath: 'small.txt' })
  assert.equal(result.exists, true)
  assert.deepEqual(result.keys, [])
})

test('键名数量达到上限时标记 keysTruncated', async () => {
  const result = await inspectSensitiveFilePath({
    workspaceRoot: root,
    relativePath: '.env',
    maxKeys: 2,
  })
  assert.equal(result.keys.length, 2)
  assert.equal(result.keysTruncated, true)
})

test('子目录里的敏感文件同样可用', async () => {
  const result = await inspectSensitiveFilePath({
    workspaceRoot: root,
    relativePath: 'config/server.key',
  })
  assert.equal(result.exists, true)
  assert.ok(!JSON.stringify(result).includes(SECRET_VALUE))
})

test('目标是目录时报 INVALID_INPUT', async () => {
  await assert.rejects(
    () => inspectSensitiveFilePath({ workspaceRoot: root, relativePath: 'config' }),
    (err: unknown) => err instanceof ToolError && err.code === 'INVALID_INPUT',
  )
})
