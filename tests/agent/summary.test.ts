// tests/agent/summary.test.ts
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildSummaryPrompt,
  getSystemPromptWithSummary,
  SUMMARY_MAX_CHARS,
} from '../../lib/agent/summary'
import type { UIMessage } from 'ai'

const msg = (id: string, role: 'user' | 'assistant', text: string): UIMessage => ({
  id,
  role,
  parts: [{ type: 'text', text }],
})

test('没有旧摘要时提示词只包含新增对话', () => {
  const prompt = buildSummaryPrompt(null, [msg('1', 'user', '什么是大模型')])
  assert.match(prompt, /还没有摘要/)
  assert.ok(!prompt.includes('已有摘要（覆盖更早的对话）'))
  assert.match(prompt, /【用户】什么是大模型/)
})

test('有旧摘要时要求合并去重而不是拼接', () => {
  const prompt = buildSummaryPrompt('旧摘要内容', [msg('2', 'user', '新问题')])
  assert.match(prompt, /已有摘要（覆盖更早的对话）/)
  assert.match(prompt, /旧摘要内容/)
  assert.match(prompt, /不要简单拼接/)
})

test('提示词带上字符上限，让模型自己约束长度', () => {
  const prompt = buildSummaryPrompt(null, [msg('1', 'user', 'x')])
  assert.ok(prompt.includes(String(SUMMARY_MAX_CHARS)))
})

test('只有文本 part 会被拍平，工具 part 不进入摘要输入', () => {
  const withTool: UIMessage = {
    id: '3',
    role: 'assistant',
    parts: [
      { type: 'text', text: '结论是 X' },
      { type: 'tool-readFile', toolCallId: 't1', state: 'output-available', input: {}, output: {} },
    ] as UIMessage['parts'],
  }
  const prompt = buildSummaryPrompt(null, [withTool])
  assert.match(prompt, /结论是 X/)
  assert.ok(!prompt.includes('tool-readFile'))
})

test('空的 parts 不会污染提示词', () => {
  const empty: UIMessage = { id: '4', role: 'assistant', parts: [] }
  const prompt = buildSummaryPrompt(null, [empty])
  assert.match(prompt, /没有可提取的文本内容/)
})

test('无摘要时 system prompt 原样返回', () => {
  const base = getSystemPromptWithSummary('inspector', null)
  assert.ok(!base.includes('早期对话摘要'))
})

test('有摘要时拼进 system prompt 并声明优先级', () => {
  const withSummary = getSystemPromptWithSummary('inspector', '摘要正文')
  assert.match(withSummary, /早期对话摘要（已压缩，替代原始历史）/)
  assert.match(withSummary, /摘要正文/)
  // 冲突时以原文为准 —— 这条规则必须写明，否则模型会拿旧摘要反驳用户
  assert.match(withSummary, /以原文为准/)
})

test('摘要注入不改变原有提示词内容', () => {
  const base = getSystemPromptWithSummary('inspector', null)
  const withSummary = getSystemPromptWithSummary('inspector', 'X')
  assert.ok(withSummary.startsWith(base), '摘要必须追加在原提示词之后，不覆盖任何原有内容')
})