// tests/agent/diff.test.ts
//
// 守住 diff 解析与校验的契约。
//
// 为什么这个文件的优先级最高：diff 是**来自模型的不可信输入**，
// 而它是 write 路径的唯一入口。解析器宽松 = 把风险推迟到 applyPatch 才暴露。
// 所以这里必须是"恶意输入也不能通过"的测试，而不是"正常输入能通过"。
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_FILES_PER_PROPOSAL,
  buildDiffTree,
  parseAndValidateDiff,
  renderDiffTree,
} from '../../lib/agent/diff'

/** 一个最小的合法 unified diff */
const GOOD_DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 export { a, b }
`

// ─────────────────────────────────────────── 正常路径

test('合法的 unified diff 解析出文件与增删行数', () => {
  const res = parseAndValidateDiff(GOOD_DIFF)
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.parsed.files.length, 1)
  assert.equal(res.parsed.files[0].path, 'src/a.ts')
  assert.equal(res.parsed.files[0].insertions, 2)
  assert.equal(res.parsed.files[0].deletions, 1)
  assert.equal(res.parsed.files[0].isNew, false)
})

test('多文件 diff 全部解析出来', () => {
  const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-old
+new
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1 +1 @@
-x
+y
`
  const res = parseAndValidateDiff(diff)
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.deepEqual(res.parsed.files.map((f) => f.path), ['a.ts', 'b.ts'])
})

test('新增文件（--- /dev/null）被识别为 isNew', () => {
  const diff = `diff --git a/new.ts b/new.ts
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+line one
+line two
`
  const res = parseAndValidateDiff(diff)
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.parsed.files[0].isNew, true)
  assert.equal(res.parsed.files[0].insertions, 2)
})

test('hunk 头省略长度时默认为 1', () => {
  const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-old
+new
`
  const res = parseAndValidateDiff(diff)
  assert.equal(res.ok, true, '省略长度的 @@ -1 +1 @@ 是合法的')
})

test('\\ No newline at end of file 不影响行数校验', () => {
  const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`
  const res = parseAndValidateDiff(diff)
  assert.equal(res.ok, true)
})

// ─────────────────────────────────────────── fail-closed：恶意/畸形输入

test('空 diff 被拒绝', () => {
  const res = parseAndValidateDiff('   \n  ')
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'EMPTY_DIFF')
})

test('不是 unified diff（纯文本）被拒绝', () => {
  const res = parseAndValidateDiff('这里应该改成 const b = 3')
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'NOT_UNIFIED_DIFF')
})

test('hunk 行数与声明不符时被拒绝（截断或伪造）', () => {
  const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,5 +1,5 @@
 only one line
`
  const res = parseAndValidateDiff(diff)
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'HUNK_LINE_COUNT_MISMATCH')
})

test('hunk 内出现无法识别的行时被拒绝（而不是跳过）', () => {
  const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,1 @@
?garbage
`
  const res = parseAndValidateDiff(diff)
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.ok(['MALFORMED_HUNK', 'HUNK_LINE_COUNT_MISMATCH'].includes(res.code))
})

test('路径穿越被拒绝', () => {
  for (const p of ['../outside.ts', 'src/../../evil.ts']) {
    const diff = `diff --git a/${p} b/${p}
--- a/${p}
+++ b/${p}
@@ -1 +1 @@
-a
+b
`
    const res = parseAndValidateDiff(diff)
    assert.equal(res.ok, false, `${p} 必须被拒绝`)
    if (res.ok) return
    assert.equal(res.code, 'PATH_TRAVERSAL')
  }
})

test('绝对路径被拒绝', () => {
  for (const p of ['/etc/passwd', 'C:/Windows/win.ini']) {
    const diff = `diff --git a/x b/x
--- ${p}
+++ ${p}
@@ -1 +1 @@
-a
+b
`
    const res = parseAndValidateDiff(diff)
    assert.equal(res.ok, false)
    if (res.ok) return
    assert.equal(res.code, 'ABSOLUTE_PATH')
  }
})

test('改动敏感文件被拒绝', () => {
  for (const p of ['.env', 'certs/server.pem', '.git/config']) {
    const diff = `diff --git a/${p} b/${p}
--- a/${p}
+++ b/${p}
@@ -1 +1 @@
-a
+b
`
    const res = parseAndValidateDiff(diff)
    assert.equal(res.ok, false, `${p} 必须被拒绝`)
    if (res.ok) return
    assert.equal(res.code, 'SENSITIVE_FILE')
  }
})

test('改动忽略目录被拒绝（与 resolveWorkspaceFile 的规则一致）', () => {
  const diff = `diff --git a/node_modules/x/index.js b/node_modules/x/index.js
--- a/node_modules/x/index.js
+++ b/node_modules/x/index.js
@@ -1 +1 @@
-a
+b
`
  const res = parseAndValidateDiff(diff)
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'IGNORED_DIRECTORY')
})

test('删除文件被拒绝（product-spec §14 Q4：V1 禁止）', () => {
  const diff = `diff --git a/gone.ts b/gone.ts
--- a/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-removed
`
  const res = parseAndValidateDiff(diff)
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'FILE_DELETION')
})

test('重命名文件被拒绝（product-spec §14 Q4：V1 禁止）', () => {
  const diff = `diff --git a/old.ts b/new.ts
--- a/old.ts
+++ b/new.ts
@@ -1 +1 @@
-a
+b
`
  const res = parseAndValidateDiff(diff)
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'FILE_RENAME')
})

test('文件数超过上限被拒绝', () => {
  const parts: string[] = []
  for (let i = 0; i <= MAX_FILES_PER_PROPOSAL; i += 1) {
    parts.push(`diff --git a/f${i}.ts b/f${i}.ts
--- a/f${i}.ts
+++ b/f${i}.ts
@@ -1 +1 @@
-a
+b
`)
  }
  const res = parseAndValidateDiff(parts.join(''))
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'TOO_MANY_FILES')
})

test('含空字节的 diff 被拒绝（二进制 / 注入）', () => {
  const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-a\0b
+c
`
  const res = parseAndValidateDiff(diff)
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'BINARY_DIFF')
})

test('git binary patch 被拒绝', () => {
  const res = parseAndValidateDiff('GIT binary patch\nliteral 123\n')
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'BINARY_DIFF')
})

// ─────────────────────────────────────────── 变更文件树

test('文件树按目录分组，文件带增删统计', () => {
  const res = parseAndValidateDiff(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1,2 @@
-old
+new
+more
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-a
+b
`)
  assert.equal(res.ok, true)
  if (!res.ok) return

  const tree = buildDiffTree(res.parsed.files)
  const dir = tree.find((n) => n.type === 'dir' && n.name === 'src')
  assert.ok(dir, '应当出现 src/ 目录节点')
  assert.equal(dir.children?.length, 1)
  assert.equal(dir.children?.[0].name, 'a.ts')
  assert.equal(dir.children?.[0].insertions, 2)
  assert.equal(dir.children?.[0].deletions, 1)

  const rootFile = tree.find((n) => n.type === 'file' && n.name === 'README.md')
  assert.ok(rootFile, '根目录文件应直接挂在树上')

  const text = renderDiffTree(tree)
  assert.match(text, /src\//)
  assert.match(text, /a\.ts/)
  assert.match(text, /README\.md/)
})

test('hunk 内的 --- / +++ 是内容行，不能当文件头（回归）', () => {
  // 这条守的是"inHunk 判断"。去掉它会把被删/被加的内容行当文件头吞掉，
  // 导致行数不符 —— 而那正是 13 个用例全挂的原因。
  const diff = `diff --git a/a.md b/a.md
--- a/a.md
+++ b/a.md
@@ -1,2 +1,2 @@
 title
---- old separator
++++ new separator
`
  const res = parseAndValidateDiff(diff)
  assert.equal(res.ok, true, `hunk 内的 --- / +++ 应作为内容行处理：${res.ok ? '' : res.message}`)
  if (!res.ok) return
  assert.equal(res.parsed.files[0].insertions, 1)
  assert.equal(res.parsed.files[0].deletions, 1)
})

test('+++ 的目标路径被校验（防止只查 diff --git 标签）', () => {
  // 安全回归：diff --git 的路径可以伪造得很安全，而真正被写的是 +++ 的路径
  for (const [target, expect] of [
    ['/etc/passwd', 'ABSOLUTE_PATH'],
    ['../outside.ts', 'PATH_TRAVERSAL'],
    ['.env', 'SENSITIVE_FILE'],
    ['node_modules/x.js', 'IGNORED_DIRECTORY'],
  ] as const) {
    const diff = `diff --git a/safe.ts b/safe.ts
--- a/safe.ts
+++ ${target}
@@ -1 +1 @@
-a
+b
`
    const res = parseAndValidateDiff(diff)
    assert.equal(res.ok, false, `${target} 必须被拒绝`)
    if (res.ok) return
    assert.equal(res.code, expect, `+++ ${target} 应报 ${expect}`)
  }
})

test('被截断的 diff 报 HUNK_LINE_COUNT_MISMATCH 而不是 MALFORMED_HUNK', () => {
  // 错误码必须指向真实故障。"被截断"是最常见的失败，
  // 报成"hunk 内有乱码"会误导排查方向。
  const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,5 +1,5 @@
 only one line
`
  const res = parseAndValidateDiff(diff)
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'HUNK_LINE_COUNT_MISMATCH')
})