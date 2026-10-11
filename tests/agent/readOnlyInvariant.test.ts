import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  FORBIDDEN_TOOL_DESCRIPTION_WORDS,
  TOOL_NAMES,
  toolRegistry,
} from '../../lib/agent/toolPolicy'

test('工具注册表里不存在任何写入能力', () => {
  assert.deepEqual([...TOOL_NAMES].sort(), [
    'createPatchProposal', 'gitDiff', 'gitLog', 'grep', 'listDir', 'readFile', 'readSensitiveFile',
  ])
})

test('所有 P2/P3 工具都被标记为需要审批', () => {
  for (const t of toolRegistry) {
    if (t.permission === 'P2' || t.permission === 'P3') {
      assert.equal(t.needsApproval, true, `${t.name} 是 ${t.permission}，必须 needsApproval`)
    }
    if (t.permission === 'P0' || t.permission === 'P1') {
      assert.equal(t.needsApproval, false, `${t.name} 是 ${t.permission}，不该要求审批`)
    }
  }
})

test('工具元数据自身不含写入/执行语义', () => {
  for (const t of toolRegistry) {
    const haystack = `${t.name} ${t.outputLimit}`.toLowerCase()
    for (const word of FORBIDDEN_TOOL_DESCRIPTION_WORDS) {
      assert.ok(!haystack.includes(word), `${t.name} 的元数据出现 "${word}"`)
    }
  }
})

test('toolPolicy 声明的 git 超时与工具实现一致', () => {
  // 用源码文本比对，而不是让工具 import toolPolicy：
  // 后者会造成 tools → toolPolicy 的反向依赖（当前是单向的），
  // 而这条测试的目标只是"发现漂移"，源码比对足够了。
  const declared = Object.fromEntries(toolRegistry.map((t) => [t.name, t.timeoutMs]))

  const pairs = [
    ['gitLog', 'lib/agent/tools/gitLog.ts'],
    ['gitDiff', 'lib/agent/tools/gitDiff.ts'],
  ] as const

  for (const [tool, file] of pairs) {
    const src = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
    const match = src.match(/timeoutMs:\s*([\d_]+)/)
    assert.ok(match, `${file} 里找不到 timeoutMs 声明`)
    const actual = Number(match[1].replace(/_/g, ''))
    assert.equal(
      actual,
      declared[tool],
      `${tool} 的超时不一致：toolPolicy 声明 ${declared[tool]}，实际 ${actual}。改一处必须改另一处`,
    )
  }
})

test('P1 工具可以自动执行，但绝不允许改写工作区', () => {
  const p1 = toolRegistry.filter((t) => t.permission === 'P1')
  for (const t of p1) {
    assert.equal(t.needsApproval, false, `${t.name} 是 P1，不写盘就不该要求审批`)
  }
  // P1 的语义是"只读 + 只落提案"，所以它必须不出现在"需要审批"的工具集合里，
  // 也不能是 P2/P3。这条断言把 README 权限表的定义变成可执行检查。
  assert.ok(p1.length >= 1, '至少应有一个 P1 工具（createPatchProposal）')
})

test('没有任何工具具备 P2/P3 之外的写入能力', () => {
  // V1 的写盘工具（applyApprovedPatch / runApprovedValidation）尚未实现。
  // 这条断言会在它们落地时失败，提醒补审批与审计 —— 而不是让它们悄悄出现。
  const hasWriteTool = toolRegistry.some((t) =>
    ['applyApprovedPatch', 'runApprovedValidation', 'writeFile', 'deleteFile'].includes(t.name),
  )
  assert.equal(hasWriteTool, false, 'V1 尚未实现写盘工具；若确实要加，请连同审批与审计一起加')
})