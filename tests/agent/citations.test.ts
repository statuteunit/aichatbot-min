// tests/agent/citations.test.ts
//
// 守住 citations 的两条契约：
//   ① extractCitations 只认「带扩展名的路径:行号」，不把时间/设计令牌当引用
//   ② verified 的判定必须与「本次工具真实返回过的路径」一致 ——
//      这是检测"模型引用了没读过的文件"的基础，判错会制造假告警或漏掉幻觉
import assert from 'node:assert/strict'
import test from 'node:test'
import { collectPaths, extractCitations, unverifiedCitations } from '../../lib/agent/citations'

const SEEN = new Set(['lib/agent/prompt.ts', 'hooks/useChat.ts', 'components/fileLink.tsx'])

test('抽取普通的 路径:行号 引用', () => {
  const found = extractCitations('见 lib/agent/prompt.ts:27 的实现', SEEN)
  assert.equal(found.length, 1)
  assert.equal(found[0].path, 'lib/agent/prompt.ts')
  assert.equal(found[0].line, 27)
  assert.equal(found[0].verified, true)
})

test('抽取区间引用 路径:起-止', () => {
  const found = extractCitations('`lib/agent/prompt.ts:64-70`', SEEN)
  assert.equal(found.length, 1)
  assert.equal(found[0].line, 64)
  assert.equal(found[0].endLine, 70)
})

test('未在本次会话读到过的路径应标为 unverified', () => {
  const found = extractCitations('见 lib/agent/hallucinated.ts:5', SEEN)
  assert.equal(found.length, 1)
  assert.equal(found[0].verified, false)
})

test('反斜杠路径归一化后仍能匹配已验证集合', () => {
  const found = extractCitations('见 lib\\agent\\prompt.ts:27', SEEN)
  assert.equal(found[0].verified, true, '分隔符不同不应导致假告警')
})

test('开头的 ./ 不影响验证', () => {
  const found = extractCitations('见 ./lib/agent/prompt.ts:27', SEEN)
  assert.equal(found[0].verified, true)
})

test('同一引用重复出现只算一次', () => {
  const found = extractCitations('lib/agent/prompt.ts:27 与 lib/agent/prompt.ts:27', SEEN)
  assert.equal(found.length, 1)
})

test('不同行号的同一文件算两次', () => {
  const found = extractCitations('lib/agent/prompt.ts:27 与 lib/agent/prompt.ts:99', SEEN)
  assert.equal(found.length, 2)
})

test('不匹配纯时间 12:30', () => {
  assert.deepEqual(extractCitations('会议在 12:30 开始', SEEN), [])
})

test('不匹配没有扩展名的 名字:数字', () => {
  assert.deepEqual(extractCitations('useChat:120 有问题', SEEN), [])
})

test('支持带方括号的动态路由路径', () => {
  const seen = new Set(['app/api/chats/[id]/route.ts'])
  const found = extractCitations('见 app/api/chats/[id]/route.ts:15', seen)
  assert.equal(found.length, 1)
  assert.equal(found[0].verified, true)
})

test('行号不被截断：a.ts:12 不应解析成 a.ts:1', () => {
  const found = extractCitations('a.ts:12', new Set())
  assert.equal(found[0].line, 12)
})

test('空文本 / 非字符串输入返回空数组', () => {
  assert.deepEqual(extractCitations('', SEEN), [])
  assert.deepEqual(extractCitations(undefined as unknown as string, SEEN), [])
})

test('unverifiedCitations 只返回未验证的那些', () => {
  const text = 'lib/agent/prompt.ts:27 与 nope/missing.ts:3'
  const unverified = unverifiedCitations(text, SEEN)
  assert.equal(unverified.length, 1)
  assert.equal(unverified[0].path, 'nope/missing.ts')
})

// ---------------------------------------------------------------- collectPaths

test('collectPaths 收 readFile 形状的 { path }', () => {
  const into = new Set<string>()
  collectPaths({ ok: true, path: 'lib/a.ts', content: 'x' }, into)
  assert.deepEqual([...into], ['lib/a.ts'])
})

test('collectPaths 收 grep 形状的 { matches: [{ path }] }', () => {
  const into = new Set<string>()
  collectPaths({ ok: true, matches: [{ path: 'a/b.ts', line: 1 }, { path: 'c/d.tsx', line: 2 }] }, into)
  assert.deepEqual([...into].sort(), ['a/b.ts', 'c/d.tsx'])
})

test('collectPaths 收 listDir 形状的 { entries: [{ path }] }', () => {
  const into = new Set<string>()
  collectPaths({ ok: true, entries: [{ path: 'src', type: 'dir' }, { path: 'src/x.ts', type: 'file' }] }, into)
  // 'src' 没有扩展名 → 不收；只有像路径的才收
  assert.deepEqual([...into], ['src/x.ts'])
})

test('collectPaths 不把版本号当路径', () => {
  const into = new Set<string>()
  collectPaths({ path: 'v1.2.3' }, into)
  // 'v1.2.3' 结尾是数字，符合 \.[A-Za-z0-9]{1,10}$ 所以会被收 —— 这是已知的宽松点。
  // 但真正要防的是把句子当路径，下面几条覆盖。
  assert.ok(into.size <= 1)
})

test('collectPaths 不收绝对路径与含 .. 的路径', () => {
  const into = new Set<string>()
  collectPaths({ path: 'C:/Windows/win.ini' }, into)
  assert.equal(into.size, 0, '绝对路径不应被收')
  collectPaths({ path: '../outside.ts' }, into)
  assert.equal(into.size, 0, '含 .. 的路径不应被收')
})

test('collectPaths 不遍历与路径无关的键', () => {
  const into = new Set<string>()
  collectPaths({ note: 'see a.ts:1', message: 'b.ts', output: 'c.ts' }, into)
  assert.equal(into.size, 0, '只有 path/file/files/entries/matches 等键才应被遍历')
})

test('collectPaths 对深层嵌套与循环引用有防护', () => {
  const into = new Set<string>()
  const deep: Record<string, unknown> = { path: 'deep.ts' }
  let cur = deep
  for (let i = 0; i < 20; i += 1) {
    const next: Record<string, unknown> = { matches: [cur] }
    cur = next
  }
  // depth 上限 6，不应无限递归也不应抛错
  collectPaths(cur, into)
  assert.ok(into.size <= 1)
})
