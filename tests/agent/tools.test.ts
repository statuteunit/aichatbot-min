// tests/agent/tools.test.ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { grepTool } from '../../lib/agent/tools/grep'
import { readFileTool } from '../../lib/agent/tools/readFile'
import { listDir } from '../../lib/agent/tools/listDir'

// 这些测试直接跑在真实仓库上，验证「一次带证据链的分析」的最小闭环
test('listDir 能列出项目根目录且忽略 node_modules', async () => {
  const res = await listDir({ path: '.', depth: 1 })
  assert.equal(res.ok, true)
  if (!res.ok) return
  const names = res.entries.map((e) => e.path)
  assert.ok(names.includes('components') || names.includes('lib'))
  assert.ok(!names.some((n) => n.startsWith('node_modules')))
  assert.ok(!names.some((n) => n.startsWith('.next')))
})

// 回归：省略 path 时也必须作用于工作区根（内部会传空字符串给 resolveWorkspaceFile）
test('listDir 省略 path 时同样作用于工作区根', async () => {
  const res = await listDir({ path: '.', depth: 1 })
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.ok(res.entries.length > 0)
})

test('readFile 返回带行号的内容，可直接用于 file:line 证据', async () => {
  const res = await readFileTool({ path: 'lib/agent/schemas.ts', startLine: 1, endLine: 5 })
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.startLine, 1)
  assert.ok(res.totalLines > 5)
  assert.ok(res.content.startsWith('1: '))
  assert.equal(res.truncated, true)
})

test('readFile 拒绝敏感文件', async () => {
  const res = await readFileTool({ path: '.env' })
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'SENSITIVE_FILE_DENIED')
})

test('grep 返回 file:line 命中的结构', async () => {
  const res = await grepTool({ pattern: 'reduceStreamEvent', glob: '.ts' })
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.ok(res.matches.length >= 1)
  assert.ok(res.matches.every((m) => typeof m.path === 'string' && m.line >= 1))
})

test('grep 非法正则返回 INVALID_INPUT 而不是抛异常', async () => {
  const res = await grepTool({ pattern: '([' })
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'INVALID_INPUT')
})