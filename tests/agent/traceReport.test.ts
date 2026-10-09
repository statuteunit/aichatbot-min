// tests/agent/traceReport.test.ts
//
// 守住 trace 聚合与验收判定的契约。
//
// 为什么必须测：验收项「traceId 与 requestId 一致」是靠这个模块判定的。
// 如果它判错了，会给出**假通过** —— 比没有验收更糟。
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseTraceLines,
  renderTrace,
  verifyTraceCoverage,
} from '../../lib/agent/traceReport'

/** 造一行结构化日志，形状与 lib/logging.ts 的 logEvent 一致 */
function logLine(fields: Record<string, unknown>): string {
  return JSON.stringify({ ts: '2026-10-09T00:00:00.000Z', level: 'info', ...fields })
}

test('按 traceId 聚合：请求事件与工具调用归入同一条 trace', () => {
  const text = [
    logLine({ event: 'chat.POST', traceId: 'T1', requestId: 'T1', status: 200, durationMs: 1200 }),
    logLine({
      event: 'agent.toolCall', traceId: 'T1', runId: 'T1', tool: 'grep',
      ok: true, code: null, durationMs: 30, inputBytes: 20, inputKeys: 'pattern', outputBytes: 500, outputHash: 'abc',
    }),
    logLine({
      event: 'chat.finish', traceId: 'T1', requestId: 'T1',
      promptTokens: 1000, completionTokens: 200, steps: 2, readFileCount: 1,
      sentMessageCount: 4, uiMessageCount: 10, hasSummary: true, stepsWithText: 1, finishReason: 'stop',
    }),
  ].join('\n')

  const summaries = parseTraceLines(text)
  assert.equal(summaries.length, 1)
  const s = summaries[0]
  assert.equal(s.traceId, 'T1')
  assert.deepEqual(s.requestIds, ['T1'])
  assert.equal(s.toolCalls.length, 1)
  assert.equal(s.toolCalls[0].tool, 'grep')
  assert.equal(s.status, 200)
  assert.equal(s.finish?.readFileCount, 1)
  assert.equal(s.finish?.hasSummary, true)
})

test('不同 traceId 分组互不干扰', () => {
  const text = [
    logLine({ event: 'chat.POST', traceId: 'A', requestId: 'A', status: 200 }),
    logLine({ event: 'chat.POST', traceId: 'B', requestId: 'B', status: 200 }),
    logLine({ event: 'agent.toolCall', traceId: 'A', tool: 'readFile', ok: true }),
    logLine({ event: 'agent.toolCall', traceId: 'B', tool: 'grep', ok: true }),
    logLine({ event: 'agent.toolCall', traceId: 'B', tool: 'listDir', ok: false, code: 'PATH_DENIED' }),
  ].join('\n')

  const summaries = parseTraceLines(text)
  const a = summaries.find((s) => s.traceId === 'A')!
  const b = summaries.find((s) => s.traceId === 'B')!
  assert.equal(a.toolCalls.length, 1)
  assert.equal(b.toolCalls.length, 2)
  assert.equal(b.toolCalls[1].code, 'PATH_DENIED')
})

test('只看指定 traceId', () => {
  const text = [
    logLine({ event: 'chat.POST', traceId: 'A', requestId: 'A' }),
    logLine({ event: 'chat.POST', traceId: 'B', requestId: 'B' }),
  ].join('\n')
  const only = parseTraceLines(text, { traceId: 'B' })
  assert.equal(only.length, 1)
  assert.equal(only[0].traceId, 'B')
})

test('不带 traceId 的行被忽略（含 Next.js 自己的非 JSON 输出）', () => {
  const text = [
    ' GET /api/chat 200 in 23.2s',                      // Next.js 输出，非 JSON
    logLine({ event: 'chat.POST', requestId: 'R1' }),   // 有 requestId 但**没有** traceId
    logLine({ event: 'chat.POST', traceId: 'T1', requestId: 'T1' }),
  ].join('\n')

  const summaries = parseTraceLines(text)
  // 关键：只有 1 条 —— 只带 requestId 而无 traceId 的行**不能**被当成 trace 收进来。
  // 否则"traceId 根本没写进日志"这个故障会被掩盖（那正是要验收的东西）。
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].traceId, 'T1')
  assert.equal(summaries[0].skippedLines, 1)
})

test('渲染结果明确给出 traceId 与 requestId 是否一致', () => {
  const same = parseTraceLines(
    logLine({ event: 'chat.POST', traceId: 'T', requestId: 'T', status: 200 }),
  )[0]
  assert.match(renderTrace(same), /与 traceId 一致 ✔/)

  const diff = parseTraceLines(
    logLine({ event: 'chat.POST', traceId: 'T', requestId: 'OTHER', status: 200 }),
  )[0]
  assert.match(renderTrace(diff), /与 traceId 不一致 ✖/)
})

test('未走到结束的 trace 会被明确指出（中断场景）', () => {
  const s = parseTraceLines(
    logLine({ event: 'agent.toolCall', traceId: 'T', tool: 'grep', ok: true }),
  )[0]
  assert.match(renderTrace(s), /未记录 chat\.finish/)
})

// ─────────────────────────────────────────── 验收判定

test('验收通过：有工具调用且 traceId 与 requestId 一致', () => {
  const text = [
    logLine({ event: 'chat.POST', traceId: 'T1', requestId: 'T1', status: 200 }),
    logLine({ event: 'agent.toolCall', traceId: 'T1', tool: 'grep', ok: true }),
  ].join('\n')
  const verdict = verifyTraceCoverage(parseTraceLines(text))
  assert.equal(verdict.passed, true)
  assert.equal(verdict.tracesWithToolCalls, 1)
  assert.equal(verdict.consistentTraces, 1)
})

test('验收失败：日志里完全没有 traceId', () => {
  const text = logLine({ event: 'chat.POST', requestId: 'R1', status: 200 })
  const verdict = verifyTraceCoverage(parseTraceLines(text))
  assert.equal(verdict.passed, false)
  assert.ok(verdict.reasons.some((r) => r.includes('找不到任何带 traceId 的行')))
})

test('验收失败：有 trace 但没有工具调用（证明不了工具被串起来）', () => {
  const text = logLine({ event: 'chat.POST', traceId: 'T1', requestId: 'T1', status: 200 })
  const verdict = verifyTraceCoverage(parseTraceLines(text))
  assert.equal(verdict.passed, false)
  assert.ok(verdict.reasons.some((r) => r.includes('没有任何 trace 记录到工具调用')))
})

test('验收失败：requestId 与 traceId 不一致', () => {
  const text = [
    logLine({ event: 'chat.POST', traceId: 'T1', requestId: 'DIFFERENT', status: 200 }),
    logLine({ event: 'agent.toolCall', traceId: 'T1', tool: 'grep', ok: true }),
  ].join('\n')
  const verdict = verifyTraceCoverage(parseTraceLines(text))
  assert.equal(verdict.passed, false)
  assert.ok(verdict.reasons.some((r) => r.includes('不一致')))
})

test('空输入不抛错，且判定为未通过', () => {
  const verdict = verifyTraceCoverage(parseTraceLines(''))
  assert.equal(verdict.passed, false)
  assert.equal(verdict.traceCount, 0)
})

// ─────────────────────────────────────────── 编码 / 脏输入容忍

test('带 UTF-8 BOM 的日志仍能解析（PowerShell Tee-Object 会写 BOM）', () => {
  // 真实症状：文件有 68 行、可解析 0 行，看起来像路径指错，实际是 BOM。
  const text = '\uFEFF' + [
    logLine({ event: 'chat.POST', traceId: 'T1', requestId: 'T1', status: 200 }),
    logLine({ event: 'agent.toolCall', traceId: 'T1', tool: 'grep', ok: true }),
  ].join('\n')

  const summaries = parseTraceLines(text)
  assert.equal(summaries.length, 1, 'BOM 不该让第一行解析失败')
  assert.equal(summaries[0].traceId, 'T1')
  assert.equal(summaries[0].toolCalls.length, 1)
})

test('每行都带 BOM 的日志也能解析', () => {
  const lines = [
    logLine({ event: 'chat.POST', traceId: 'T1', requestId: 'T1', status: 200 }),
    logLine({ event: 'agent.toolCall', traceId: 'T1', tool: 'grep', ok: true }),
  ].map((l) => `\uFEFF${l}`)

  const summaries = parseTraceLines(lines.join('\n'))
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].toolCalls.length, 1)
})

test('零宽空格前缀同样被清理', () => {
  const text = '\u200B' + logLine({ event: 'chat.POST', traceId: 'T1', requestId: 'T1' })
  assert.equal(parseTraceLines(text).length, 1)
})

test('CRLF 换行不影响解析', () => {
  const text = [
    logLine({ event: 'chat.POST', traceId: 'T1', requestId: 'T1', status: 200 }),
    logLine({ event: 'agent.toolCall', traceId: 'T1', tool: 'grep', ok: true }),
  ].join('\r\n')

  const summaries = parseTraceLines(text)
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].toolCalls.length, 1)
})

