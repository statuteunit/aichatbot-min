// tests/agent/security.test.ts
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { isSensitivePath, resolveWorkspaceFile, ToolError } from '../../lib/agent/security'

let root: string
let outside: string

before(async () => {
  // 独立临时工作区，不污染真实仓库
  root = await mkdtemp(path.join(tmpdir(), 'agent-ws-'))
  outside = await mkdtemp(path.join(tmpdir(), 'agent-outside-'))
  await mkdir(path.join(root, 'src'), { recursive: true })
  await writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1\n')
  await writeFile(path.join(root, '.env'), 'SECRET=1\n')
  await writeFile(path.join(root, 'server.key'), 'KEY\n')
  await writeFile(path.join(outside, 'secret.txt'), 'TOP SECRET\n')
})

after(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

async function expectDenied(p: string, code: string) {
  await assert.rejects(
    () => resolveWorkspaceFile(root, p),
    (err: unknown) => err instanceof ToolError && err.code === code,
    `期望 ${p} 被拒绝为 ${code}`,
  )
}

test('正常相对路径解析成功且落在工作区内', async () => {
  const abs = await resolveWorkspaceFile(root, 'src/a.ts')
  assert.equal(path.relative(root, abs), path.join('src', 'a.ts'))
})

test('拒绝 .. 穿越', async () => {
  await expectDenied('../outside.txt', 'PATH_DENIED')
  await expectDenied('src/../../outside.txt', 'PATH_DENIED')
})

test('拒绝绝对路径（POSIX 与 Windows 盘符）', async () => {
  await expectDenied(path.join(outside, 'secret.txt'), 'PATH_DENIED')
  await expectDenied('C:\\Windows\\win.ini', 'PATH_DENIED')
})

test('拒绝空字节', async () => {
  await expectDenied('src/a\0.ts', 'PATH_DENIED')
})

test('拒绝敏感文件', async () => {
  await expectDenied('.env', 'SENSITIVE_FILE_DENIED')
  await expectDenied('server.key', 'SENSITIVE_FILE_DENIED')
})

test('敏感文件模式识别（含例外）', () => {
  assert.equal(isSensitivePath('.env'), true)
  assert.equal(isSensitivePath('.env.production'), true)
  assert.equal(isSensitivePath('certs/server.pem'), true)
  assert.equal(isSensitivePath('.git/config'), true)
  assert.equal(isSensitivePath('src/a.ts'), false)
  // 显式例外：模板文件对分析有用
  assert.equal(isSensitivePath('.env.example'), false)
})

test('符号链接逃逸被拒绝', async (t) => {
  const linkPath = path.join(root, 'escape')
  try {
    await symlink(outside, linkPath, 'junction')
  } catch {
    t.skip('当前环境不支持创建符号链接，跳过')
    return
  }
  await expectDenied('escape/secret.txt', 'PATH_DENIED')
})

test('不存在的路径报 NOT_FOUND 而不是 500', async () => {
  await expectDenied('src/nope.ts', 'NOT_FOUND')
})

// 回归：listDir / grep 在「不限定子目录」时会传空字符串表示工作区根。
// 早期实现把空字符串当成非法输入，导致这两个工具在根目录层级直接 INVALID_INPUT。
test('根路径的三种写法（"" / "." / "./"）都解析到工作区根', async () => {
  const expected = await resolveWorkspaceFile(root, 'src')
  const rootAbs = path.dirname(expected)
  for (const variant of ['', '.', './']) {
    const abs = await resolveWorkspaceFile(root, variant)
    assert.equal(abs, rootAbs, `写法 ${JSON.stringify(variant)} 应解析到工作区根`)
  }
})

test('根路径写法不会绕过护栏', async () => {
  await expectDenied('./\0', 'PATH_DENIED')
  await expectDenied('./..', 'PATH_DENIED')
  await expectDenied('a/./../../b', 'PATH_DENIED')
})