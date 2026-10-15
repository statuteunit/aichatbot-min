import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildTargetFiles,
  parseFilePatches,
  renderUnifiedDiff,
  reverseFilePatch,
} from '@/lib/agent/patch'

const ORIGINAL = ['export const a = 1', 'export const b = 2', ''].join('\n')
const TARGET = ['export const a = 1', 'export const b = 3', 'export const c = 4', ''].join('\n')
const DIFF = [
  'diff --git a/lib/x.ts b/lib/x.ts',
  '--- a/lib/x.ts',
  '+++ b/lib/x.ts',
  '@@ -1,2 +1,3 @@',
  ' export const a = 1',
  '-export const b = 2',
  '+export const b = 3',
  '+export const c = 4',
  '',
].join('\n')

/**
 * 解析失败就抛，不用 assert 检查 ok。
 *
 * 为什么：`assert.equal(parsed.ok, true)` 的签名是 `asserts actual is T` ——
 * 它会让 TS 认定 parsed.ok 就是字面量 true，此后再写 `if (!parsed.ok)`
 * 就是不可达分支，里面访问 parsed.message 会直接编译不过。
 * 守卫既收窄类型，又能在失败时把 code/message 带出来。
 */
function parseOrThrow(diff: string) {
  const parsed = parseFilePatches(diff)
  if (!parsed.ok) throw new Error(`${parsed.code}: ${parsed.message}`)
  return parsed.files
}

function reversedDiff(): string {
  return renderUnifiedDiff(parseOrThrow(DIFF).map(reverseFilePatch))
}

test('反转两次回到原补丁（行号与 +/- 都复原）', () => {
  const back = renderUnifiedDiff(parseOrThrow(reversedDiff()).map(reverseFilePatch))
  assert.equal(back, DIFF)
})

test('反转后的补丁能把目标内容还原成原文', () => {
  const built = buildTargetFiles(reversedDiff(), { 'lib/x.ts': TARGET })
  if (!built.ok) throw new Error(`反转补丁应当可用，却被拒绝：${built.code} ${built.message}`)
  assert.equal(built.plans[0].targetContent, ORIGINAL)
})

test('目标内容被人再改过时，反转补丁必须拒绝应用（回滚安全阀）', () => {
  const tampered = TARGET.replace('c = 4', 'c = 9')
  const built = buildTargetFiles(reversedDiff(), { 'lib/x.ts': tampered })
  if (built.ok) throw new Error('目标内容已被改过，反转补丁却仍然应用成功了')
  assert.equal(built.code, 'HUNK_CONTEXT_MISMATCH')
})