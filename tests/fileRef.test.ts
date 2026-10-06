// tests/fileRef.test.ts
//
// `file:line` 链接化是个启发式正则：它既要匹配真实引用，又不能把
// 「12:30」「.foo:1」「node_modules/x.ts」这类东西误判成文件。
// 误匹配比漏匹配更难发现 —— 用户会看到一堆莫名其妙的可点击文字。
import assert from 'node:assert/strict'
import test from 'node:test'
import { FILE_REF_PATTERN } from '../components/fileLink'

/** 用带 g 标志的副本做匹配，避免污染导出常量的 lastIndex */
function firstMatch(text: string): RegExpExecArray | null {
  return new RegExp(FILE_REF_PATTERN.source).exec(text)
}

test('匹配 路径:行号', () => {
  const m = firstMatch('见 hooks/useChat.ts:120 的实现')
  assert.ok(m)
  assert.equal(m[1], 'hooks/useChat.ts')
  assert.equal(m[2], '120')
  assert.equal(m[3], undefined)
})

test('匹配 路径:起-止', () => {
  const m = firstMatch('lib/agent/security.ts:103-118 这一段')
  assert.ok(m)
  assert.equal(m[1], 'lib/agent/security.ts')
  assert.equal(m[2], '103')
  assert.equal(m[3], '118')
})

test('匹配带方括号的动态路由路径（本项目最常见形式）', () => {
  const m = firstMatch('app/api/chats/[id]/messages/route.ts:58')
  assert.ok(m, '动态路由路径必须能匹配，否则最常见的引用会漏掉')
  assert.equal(m[1], 'app/api/chats/[id]/messages/route.ts')
  assert.equal(m[2], '58')
})

test('不把行号截断：a.ts:12 不应匹配出 a.ts:1', () => {
  const m = firstMatch('a.ts:12')
  assert.ok(m)
  assert.equal(m[2], '12')
})

test('匹配 Windows 反斜杠路径', () => {
  const m = firstMatch('lib\\agent\\security.ts:10')
  assert.ok(m)
  assert.equal(m[1], 'lib\\agent\\security.ts')
})

test('不匹配纯时间（12:30）', () => {
  assert.equal(firstMatch('会议在 12:30 开始'), null)
})

test('不匹配没有扩展名的 名字:数字', () => {
  assert.equal(firstMatch('useChat:120 有问题'), null)
})

test('不匹配设计令牌里的冒号', () => {
  assert.equal(firstMatch('color: red, red: 1'), null)
})

test('不把中文吞进路径', () => {
  const m = firstMatch('见 hooks/useChat.ts:120')
  assert.ok(m)
  // 关键：路径不能含中文，否则会把「见」也变成链接的一部分
  assert.equal(m[1], 'hooks/useChat.ts')
})

test('用 match 统计匹配次数时不受捕获组影响（只数整体匹配）', () => {
  // 注意：这与上面的 split 不同 —— match 配 g 标志返回的是**整体匹配**，
  // 不含捕获组，所以这里是 2 而不是 4。
  const matches = 'a.ts:1 与 b.ts:2'.match(new RegExp(FILE_REF_PATTERN.source, 'g'))
  assert.deepEqual(matches, ['a.ts:1', 'b.ts:2'])
})

test('split 的结果结构：每 4 个位置一组，末尾还有一段余项', () => {
  // 关键不变量：renderWithFileRefs 用 i += 4 遍历。
  // 注意 split **总会**返回 (匹配组数 + 1) 个文本片段：
  //   索引 0       匹配前的文本
  //   索引 1..3    三个捕获组（路径 / 起 / 止）
  //   索引 4       匹配后的文本（这里为空串）
  // 也就是长度 = 4 * n + 1，n 是匹配次数。末尾那一项固定存在，不能按长度断言成 4。
  const one = 'a.ts:1'.split(new RegExp(FILE_REF_PATTERN.source, 'g'))
  assert.deepEqual(one, ['', 'a.ts', '1', undefined, ''])

  // 两次匹配：4*2 + 1 = 9
  const two = 'a.ts:1 与 b.ts:2'.split(new RegExp(FILE_REF_PATTERN.source, 'g'))
  assert.equal(two.length, 9)
  assert.equal(two[0], '')
  assert.equal(two[1], 'a.ts')
  assert.equal(two[2], '1')
  assert.equal(two[4], ' 与 ')
  assert.equal(two[5], 'b.ts')
  assert.equal(two[6], '2')
})

test('按 i += 4 遍历能正确取出位于匹配后方的引用', () => {
  // 这条是真正验证消费逻辑的：若步长或偏移写错，
  // 第二个引用（b.ts）就会丢失或错位。
  const pieces = '见 a.ts:1 与 b.ts:2 的实现'.split(new RegExp(FILE_REF_PATTERN.source, 'g'))

  const collected: Array<{ path: string; start: string; end: string | undefined }> = []
  for (let i = 0; i < pieces.length; i += 4) {
    if (pieces[i + 1] && pieces[i + 2]) {
      collected.push({ path: pieces[i + 1], start: pieces[i + 2], end: pieces[i + 3] })
    }
  }

  assert.deepEqual(collected, [
    { path: 'a.ts', start: '1', end: undefined },
    { path: 'b.ts', start: '2', end: undefined },
  ])
})
