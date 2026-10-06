// tests/agent/gitTools.test.ts
//
// 只测纯解析逻辑，不 spawn 子进程：
// runGit 需要真正的 git 子进程，在受限环境下无法执行（管道 stdio 被拒），
// 而解析逻辑是这两个工具里最容易出错的部分（分隔符、二进制文件、中文路径），
// 单独覆盖它能在不依赖 git 的情况下守住回归。
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseGitLog } from '../../lib/agent/tools/gitLog'
import { parseNumstat } from '../../lib/agent/tools/gitDiff'

// 与 gitLog.ts 里 LOG_FORMAT 的分隔符保持一致
const FS = '\x1f'
const RS = '\x1e'

const RAW_LOG =
  `abc123${FS}abc${FS}Alice${FS}2026-10-02T10:00:00+08:00${FS}feat: 加入中文标题${RS}\n` +
  `def456${FS}def${FS}Bob${FS}2026-10-01T09:30:00+08:00${FS}fix: 修复 bug ${FS} with separator${RS}\n` +
  `789aaa${FS}789${FS}Carol${FS}2026-09-30T08:00:00+08:00${FS}chore: 清理${RS}\n`

test('parseGitLog 解析出每条提交的全部字段', () => {
  const commits = parseGitLog(RAW_LOG)
  assert.equal(commits.length, 3)
  assert.deepEqual(commits[0], {
    hash: 'abc123',
    shortHash: 'abc',
    author: 'Alice',
    date: '2026-10-02T10:00:00+08:00',
    subject: 'feat: 加入中文标题',
  })
})

test('parseGitLog 保留 subject 里出现的字段分隔符', () => {
  const commits = parseGitLog(RAW_LOG)
  assert.equal(commits[1].subject, 'fix: 修复 bug \x1f with separator')
})

test('parseGitLog 对空输出返回空数组（空仓库场景）', () => {
  assert.deepEqual(parseGitLog(''), [])
  assert.deepEqual(parseGitLog('\n'), [])
})

test('parseGitLog 丢弃没有 hash 的不完整记录', () => {
  assert.deepEqual(parseGitLog(`${FS}${FS}no-hash${RS}`), [])
})

const RAW_NUMSTAT = [
  '12\t3\thooks/useChat.ts',
  '0\t8\tlib/store.ts',
  '-\t-\tpublic/logo.png',
  '',
].join('\n')

test('parseNumstat 解析每个文件的增删行数', () => {
  const { stats } = parseNumstat(RAW_NUMSTAT)
  assert.deepEqual(stats['hooks/useChat.ts'], { insertions: 12, deletions: 3 })
  assert.deepEqual(stats['lib/store.ts'], { insertions: 0, deletions: 8 })
})

test('parseNumstat 把二进制文件的 "-" 归零而不是产生 NaN', () => {
  const { stats } = parseNumstat(RAW_NUMSTAT)
  assert.deepEqual(stats['public/logo.png'], { insertions: 0, deletions: 0 })
})

test('parseNumstat 返回相对仓库根的文件清单', () => {
  const { files } = parseNumstat(RAW_NUMSTAT)
  assert.deepEqual(files, ['hooks/useChat.ts', 'lib/store.ts', 'public/logo.png'])
})

test('parseNumstat 处理含空格与中文的路径', () => {
  const { stats, files } = parseNumstat('1\t2\tdocs/我的 文档.md\n')
  assert.deepEqual(files, ['docs/我的 文档.md'])
  assert.deepEqual(stats['docs/我的 文档.md'], { insertions: 1, deletions: 2 })
})

test('parseNumstat 对空输出返回空结果', () => {
  assert.deepEqual(parseNumstat(''), { stats: {}, files: [] })
})
