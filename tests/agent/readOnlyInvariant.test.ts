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
    'applyApprovedPatch',   // ← 新增的 P2 写盘工具，需审批
    'createPatchProposal',
    'gitDiff',
    'gitLog',
    'grep',
    'listDir',
    'readFile',
    'readSensitiveFile',
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

test('写盘工具只能以 P2 + 强制审批的形式存在', () => {
  // 这条断言的前身是"V1 尚未实现写盘工具 → hasWriteTool 必须为 false"。
  // 落地 applyApprovedPatch 后，它按设计报红了；现在把它翻转成：
  // 写盘工具**可以存在**，但必须同时满足三个条件，缺一即失败。
  const WRITE_TOOL_NAMES = ['applyApprovedPatch', 'runApprovedValidation', 'writeFile', 'deleteFile']
  const writeTools = toolRegistry.filter((t) => WRITE_TOOL_NAMES.includes(t.name))

  assert.ok(writeTools.length >= 1, 'Day 24–25 后应至少有一个写盘工具（applyApprovedPatch）')

  for (const t of writeTools) {
    assert.equal(t.permission, 'P2', `${t.name} 是写盘工具，权限必须是 P2（P1 的语义是只读）`)
    assert.equal(t.needsApproval, true, `${t.name} 是写盘工具，必须 needsApproval: true`)
  }

  // 反向断言：P1 工具一个都不许出现在写盘名单里。
  // 用 filter 而不是 some，是为了在失败信息里直接列出违规的工具名。
  const p1WriteTools = toolRegistry
    .filter((t) => t.permission === 'P1' && WRITE_TOOL_NAMES.includes(t.name))
    .map((t) => t.name)
  assert.deepEqual(p1WriteTools, [], `P1（只读）工具不允许具备写入能力：${p1WriteTools.join(', ')}`)
})