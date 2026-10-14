import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import {
  buildValidationCommand,
  buildValidationEnv,
  isValidationTaskId,
  truncateUtf8,
  VALIDATION_MAX_OUTPUT_BYTES,
  VALIDATION_MAX_TIMEOUT_MS,
  VALIDATION_TASK_IDS,
  VALIDATION_TASKS,
} from '../../lib/agent/validation'

test('只注册了 product-spec 允许的三个任务', () => {
  assert.deepEqual([...VALIDATION_TASK_IDS].sort(), ['lint', 'test', 'typecheck'])
})

test('taskId 判定只认注册值，不认命令字符串，也不认原型链上的键', () => {
  assert.equal(isValidationTaskId('lint'), true)
  assert.equal(isValidationTaskId('typecheck'), true)
  assert.equal(isValidationTaskId('test'), true)
  assert.equal(isValidationTaskId('pnpm lint'), false)
  assert.equal(isValidationTaskId('lint --fix'), false)
  assert.equal(isValidationTaskId(''), false)
  assert.equal(isValidationTaskId(null), false)
  assert.equal(isValidationTaskId('toString'), false)
})

test('每个任务的入口都是 node_modules 里的 JS 入口，不是 .cmd 垫片', () => {
  for (const id of VALIDATION_TASK_IDS) {
    const task = VALIDATION_TASKS[id]
    assert.ok(task.entry.startsWith('node_modules/'), `${id} 的入口必须在 node_modules 里：${task.entry}`)
    assert.ok(
      task.entry.endsWith('.js') || task.entry.endsWith('.mjs'),
      `${id} 的入口必须是 JS 入口（.cmd 垫片在 shell:false 下会 ENOENT/EINVAL）：${task.entry}`,
    )
    for (const arg of task.args) {
      assert.equal(typeof arg, 'string')
    }
    assert.ok(task.timeoutMs > 0 && task.timeoutMs <= VALIDATION_MAX_TIMEOUT_MS, `${id} 的超时越界`)
  }
})

test('lint 绝不带 --fix（验证不许改写文件）', () => {
  assert.deepEqual([...VALIDATION_TASKS.lint.args], ['.'])
})

test('typecheck 用 --noEmit 且不写 tsbuildinfo', () => {
  assert.ok(VALIDATION_TASKS.typecheck.args.includes('--noEmit'))
  const i = VALIDATION_TASKS.typecheck.args.indexOf('--incremental')
  assert.ok(i >= 0 && VALIDATION_TASKS.typecheck.args[i + 1] === 'false')
})

test('子进程环境只透传白名单：密钥、NODE_OPTIONS、AGENT_* 一律不进', () => {
  const env = buildValidationEnv({
    PATH: 'C:\\bin',
    SystemRoot: 'C:\\Windows',
    NODE_ENV: 'test',
    POSTGRES_PRISMA_URL: 'postgres://secret',
    POSTGRES_URL_NON_POOLING: 'postgres://secret',
    AUTH_SECRET: 'secret',
    AUTH_GITHUB_SECRET: 'secret',
    OPENROUTER_API_KEY: 'sk-secret',
    AGENT_WORKSPACE_ROOT: 'D:\\repo',
    NODE_OPTIONS: '--require ./evil.js',
  })
  assert.equal(env.PATH, 'C:\\bin')
  assert.equal(env.SystemRoot, 'C:\\Windows')
  assert.equal(env.CI, '1')
  assert.equal(env.NO_COLOR, '1')

  const leaked = [
    'POSTGRES_PRISMA_URL',
    'POSTGRES_URL_NON_POOLING',
    'AUTH_SECRET',
    'AUTH_GITHUB_SECRET',
    'OPENROUTER_API_KEY',
    'AGENT_WORKSPACE_ROOT',
    'NODE_OPTIONS',
  ].filter((key) => key in env)
  assert.deepEqual(leaked, [], `这些变量不该出现在子进程环境里：${leaked.join(', ')}`)
})

test('命令由服务端拼装：解释器是 process.execPath，cwd 固定为工作区根', async () => {
  const root = process.cwd() // 真实仓库根：入口文件确实存在，能过 stat 校验
  const cmd = await buildValidationCommand('lint', root)
  assert.equal(cmd.command, process.execPath)
  assert.equal(cmd.cwd, root)
  assert.equal(path.isAbsolute(cmd.args[0] ?? ''), true)
  assert.ok((cmd.args[0] ?? '').endsWith(path.join('node_modules', 'eslint', 'bin', 'eslint.js')))
  assert.equal(cmd.env.CI, '1')
})

test('输出按字节截断（中文不会被当成 1 字节）', () => {
  const short = truncateUtf8('中文 abc', 100)
  assert.equal(short.truncated, false)
  assert.equal(short.text, '中文 abc')

  // 每个汉字 3 字节：1000 个字 = 3000 字节，默认上限 40KB 还不够触发
  const huge = truncateUtf8('中'.repeat(100_000))
  assert.equal(huge.truncated, true)
  assert.ok(huge.text.includes('输出已截断'))
  assert.ok(
    Buffer.byteLength(huge.text, 'utf8') < Buffer.byteLength('中'.repeat(100_000), 'utf8'),
    '截断后必须真的变小',
  )
  assert.ok(VALIDATION_MAX_OUTPUT_BYTES < Buffer.byteLength('中'.repeat(100_000), 'utf8'))
})