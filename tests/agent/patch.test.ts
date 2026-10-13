// tests/agent/patch.test.ts
//
// 守住"给定原文 + diff → 新文"的重建正确性。
//
// 为什么这个文件的优先级最高：apply.ts 会**真的写用户的仓库**，
// 而写什么完全由 buildTargetFiles 决定。这里错了，回滚机制救不了
// —— 回滚只能恢复成"原样"，不能把"错误的新内容"变对。
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTargetFiles, parseFilePatches } from '../../lib/agent/patch'
import { EMPTY_FILE_SHA256, sha256 } from '../../lib/agent/workspace'

/** 构造一个改单行的 diff */
function editOneLine(): string {
  return `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,4 @@
 const a = 1
-const b = 2
+const b = 3
 const c = 3
 export { a, b, c }
`
}

const ORIGINAL = 'const a = 1\nconst b = 2\nconst c = 3\nexport { a, b, c }\n'
const EXPECTED = 'const a = 1\nconst b = 3\nconst c = 3\nexport { a, b, c }\n'

// ─────────────────────────────────────────── 正常重建

test('改单行：目标内容正确', () => {
  const res = buildTargetFiles(editOneLine(), { 'src/a.ts': ORIGINAL })
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.plans.length, 1)
  assert.equal(res.plans[0].targetContent, EXPECTED)
})

test('目标 hash 与 sha256(target) 一致，基线 hash 与 sha256(原文) 一致', () => {
  const res = buildTargetFiles(editOneLine(), { 'src/a.ts': ORIGINAL })
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.plans[0].baseHash, sha256(ORIGINAL))
  assert.equal(res.plans[0].targetHash, sha256(EXPECTED))
  // 交叉验证：patch.ts 的 hash 必须与 workspace.ts 的 sha256 是同一算法，
  // 否则幂等判定永远不成立（两侧用不同算法算 hash）
  assert.notEqual(res.plans[0].baseHash, res.plans[0].targetHash)
})

test('新增文件：原文为空，target 等于补丁的全部新增行', () => {
  const diff = `diff --git a/new.ts b/new.ts
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+line one
+line two
`
  const res = buildTargetFiles(diff, {})
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.plans[0].targetContent, 'line one\nline two\n')
  assert.equal(res.plans[0].existsBefore, false)
})

test('多处 hunk：各自独立应用，未涉及部分原样保留', () => {
  const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
-aa
+AA
 bb
@@ -5,2 +5,2 @@
 ee
-ff
+FF
`
  const original = 'aa\nbb\ncc\ndd\nee\nff\n'
  const res = buildTargetFiles(diff, { 'a.ts': original })
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.plans[0].targetContent, 'AA\nbb\ncc\ndd\nee\nFF\n')
})

test('多个文件：各自重建，互不影响', () => {
  const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-a
+A
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1 +1 @@
-b
+B
`
  const res = buildTargetFiles(diff, { 'a.ts': 'a\n', 'b.ts': 'b\n' })
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.plans.length, 2)
  assert.equal(res.plans[0].targetContent, 'A\n')
  assert.equal(res.plans[1].targetContent, 'B\n')
})

// ─────────────────────────────────────────── 上下文不符必须拒绝

test('待删除行与磁盘不符时拒绝（基线已变）', () => {
  const res = buildTargetFiles(editOneLine(), { 'src/a.ts': 'const a = 1\nconst b = 999\nconst c = 3\nexport { a, b, c }\n' })
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'HUNK_CONTEXT_MISMATCH')
})

test('上下文行与磁盘不符时同样拒绝', () => {
  const res = buildTargetFiles(editOneLine(), { 'src/a.ts': 'const a = 1\nconst b = 2\nCHANGED\n' })
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'HUNK_CONTEXT_MISMATCH')
})

test('标注为新增但磁盘已有内容时拒绝', () => {
  const diff = `diff --git a/x.ts b/x.ts
--- /dev/null
+++ b/x.ts
@@ -0,0 +1,1 @@
+x
`
  const res = buildTargetFiles(diff, { 'x.ts': '已有内容\n' })
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'HUNK_CONTEXT_MISMATCH')
})

test('hunk 起始行越界时拒绝', () => {
  const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -100,1 +100,1 @@
-a
+b
`
  const res = buildTargetFiles(diff, { 'a.ts': 'a\n' })
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.ok(['HUNK_RANGE_INVALID', 'HUNK_CONTEXT_MISMATCH'].includes(res.code))
})

test('hunk 之间重叠时拒绝', () => {
  const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 a
-b
+B
 c
@@ -2,3 +2,3 @@
 b
-c
+C
 d
`
  const res = buildTargetFiles(diff, { 'a.ts': 'a\nb\nc\nd\n' })
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.ok(['HUNK_RANGE_INVALID', 'HUNK_CONTEXT_MISMATCH'].includes(res.code))
})

// ─────────────────────────────────────────── 不支持的格式必须明确拒绝

test('\\ No newline at end of file 被明确拒绝（不做静默处理）', () => {
  const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-a
\\ No newline at end of file
+b
\\ No newline at end of file
`
  const res = buildTargetFiles(diff, { 'a.ts': 'a' })
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'NO_NEWLINE_UNSUPPORTED')
})

test('hunk 行数与声明不符时拒绝', () => {
  const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,5 +1,5 @@
 only one line
`
  const res = buildTargetFiles(diff, { 'a.ts': 'x\n' })
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.ok(
    ['HUNK_CONTEXT_MISMATCH', 'MALFORMED_HUNK', 'HUNK_LINE_COUNT_MISMATCH'].includes(res.code),
  )
})

// ─────────────────────────────────────────── 与 diff.ts 的护栏一致

test('恶意路径在这里同样被拒（复用 diff.ts 的入口校验）', () => {
  const diff = `diff --git a/../../etc/passwd b/../../etc/passwd
--- a/../../etc/passwd
+++ b/../../etc/passwd
@@ -1 +1 @@
-a
+b
`
  const res = buildTargetFiles(diff, {})
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'PATH_TRAVERSAL')
})

test('删除文件在这里同样被拒', () => {
  const diff = `diff --git a/gone.ts b/gone.ts
--- a/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-removed
`
  const res = buildTargetFiles(diff, { 'gone.ts': 'removed\n' })
  assert.equal(res.ok, false)
  if (res.ok) return
  assert.equal(res.code, 'FILE_DELETION')
})

// ─────────────────────────────────────────── 新增文件的基线语义

test('新增文件的基线 hash 等于空文件 hash（与 workspace.ts 一致）', () => {
  const diff = `diff --git a/new.ts b/new.ts
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,1 @@
+x
`
  const res = buildTargetFiles(diff, {})
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.plans[0].baseHash, EMPTY_FILE_SHA256)
})

test('parseFilePatches 能解析出多个文件块', () => {
  const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-a
+A
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1 +1 @@
-b
+B
`
  const res = parseFilePatches(diff)
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.deepEqual(res.files.map((f) => f.path), ['a.ts', 'b.ts'])
})