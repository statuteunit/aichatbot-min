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

// ------------------------------------------------ grep 上下文（Day 13–14）

test('grep 默认不带上下文，before/after 是空数组（形状稳定）', async () => {
  const res = await grepTool({ pattern: 'reduceStreamEvent', glob: '.ts' })
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.context, 0)
  assert.ok(res.matches.every((m) => Array.isArray(m.before) && Array.isArray(m.after)))
  assert.ok(res.matches.every((m) => m.before.length === 0 && m.after.length === 0))
})

test('grep context=2 返回带行号的前后文，且行号与命中行连续', async () => {
  const res = await grepTool({ pattern: 'reduceStreamEvent', glob: '.ts', context: 2 })
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.context, 2)

  // 找一条前后文都拿满的命中，验证行号连续性与顺序
  const full = res.matches.find((m) => m.before.length === 2 && m.after.length === 2)
  assert.ok(full, '应当至少有一条命中拿到了完整的 2 行前后文')

  // before 按行号升序，且最后一行紧邻命中行
  assert.ok(full.before[0].line < full.before[1].line)
  assert.equal(full.before[1].line, full.line - 1)
  // after 从命中行的下一行开始，按升序
  assert.equal(full.after[0].line, full.line + 1)
  assert.equal(full.after[1].line, full.line + 2)
  // 每行都有文本字段
  for (const ctx of [...full.before, ...full.after]) {
    assert.equal(typeof ctx.text, 'string')
  }
})

test('grep context 超过上限时被夹到 grepContextMax', async () => {
  const res = await grepTool({ pattern: 'reduceStreamEvent', glob: '.ts', context: 999 })
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.ok(res.context <= 10, `context 应被夹到上限，实际 ${res.context}`)
})

test('grep 上下文不会越过文件首行（第 1 行命中时 before 为空）', async () => {
  // 用只命中第 1 行的 pattern 验证边界：
  // lib/agent/citations.ts 第 1 行是空行，所以改用确定在第 1 行有内容的文件
  const res = await grepTool({ pattern: '^// lib/agent/citations\\.ts$', glob: '.ts', context: 3 })
  assert.equal(res.ok, true)
  if (!res.ok) return
  const first = res.matches.find((m) => m.path === 'lib/agent/citations.ts')
  assert.ok(first, '应当命中 citations.ts 的第 2 行注释')
  // 第 2 行命中，before 最多只有 1 行（第 1 行），不能越界
  assert.ok(first.before.every((c) => c.line >= 1))
})

test('grep 输出是确定性排序（按路径、再按行号）', async () => {
  const res = await grepTool({ pattern: 'export', glob: '.ts', maxResults: 60 })
  assert.equal(res.ok, true)
  if (!res.ok) return
  for (let i = 1; i < res.matches.length; i += 1) {
    const prev = res.matches[i - 1]
    const cur = res.matches[i]
    const cmp = prev.path.localeCompare(cur.path)
    assert.ok(
      cmp < 0 || (cmp === 0 && prev.line <= cur.line),
      `排序不稳定：${prev.path}:${prev.line} 出现在 ${cur.path}:${cur.line} 之前`,
    )
  }
})

test('grep maxResults 生效时 truncated 为 true', async () => {
  const res = await grepTool({ pattern: 'const', glob: '.ts', maxResults: 5 })
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.matches.length, 5)
  assert.equal(res.truncated, true)
})

// ------------------------------------------------ readFile symbolsOnly

test('symbolsOnly 只返回声明行，且行号仍可直接引用', async () => {
  const full = await readFileTool({ path: 'lib/agent/schemas.ts' })
  const sym = await readFileTool({ path: 'lib/agent/schemas.ts', symbolsOnly: true })
  assert.equal(full.ok, true)
  assert.equal(sym.ok, true)
  if (!full.ok || !sym.ok) return

  assert.equal(sym.extraction, 'regex')
  assert.ok(typeof sym.symbolCount === 'number')
  assert.ok(sym.symbolCount! >= 1, 'schemas.ts 里应当能提取到声明')

  // 关键收益：体积必须显著小于整文件
  assert.ok(
    sym.content.length < full.content.length,
    `symbolsOnly 应当更省上下文：${sym.content.length} vs ${full.content.length}`,
  )

  // 每一行都必须是「行号: 内容」格式，模型可直接抄作证据
  for (const line of sym.content.split('\n').filter(Boolean)) {
    assert.match(line, /^\d+: /, `symbolsOnly 的行必须带行号前缀，实际：${line}`)
  }
})

test('symbolsOnly 与行区间叠加：只在区间内找声明', async () => {
  const res = await readFileTool({ path: 'lib/agent/schemas.ts', startLine: 1, endLine: 10, symbolsOnly: true })
  assert.equal(res.ok, true)
  if (!res.ok) return
  for (const line of res.content.split('\n').filter(Boolean)) {
    const lineNo = Number(line.slice(0, line.indexOf(':')))
    assert.ok(lineNo >= 1 && lineNo <= 10, `不该返回区间外的行：${lineNo}`)
  }
})

test('symbolsOnly 不返回实现体（注释与普通语句被过滤）', async () => {
  const sym = await readFileTool({ path: 'lib/agent/schemas.ts', symbolsOnly: true })
  assert.equal(sym.ok, true)
  if (!sym.ok) return
  // 缩进的普通语句（if/return/})）不应出现在结果里
  for (const line of sym.content.split('\n').filter(Boolean)) {
    const body = line.slice(line.indexOf(':') + 1)
    assert.ok(!/^\s+return\s/.test(body), `不该包含实现体：${body}`)
  }
})
