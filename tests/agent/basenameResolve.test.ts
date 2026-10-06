// tests/agent/basenameResolve.test.ts
//
// 守住 findFilesByBasename 的契约。它是「模型只写文件名」时的兜底解析，
// 属于安全相关的代码（会遍历整个工作区），所以三条约束必须有测试：
//   ① 不返回敏感文件（否则"搜索"就成了绕过屏蔽的通道）
//   ② 不进入忽略目录（node_modules / .next 等）
//   ③ 歧义时返回全部候选，绝不替调用方随便挑一个
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { findFilesByBasename } from '../../lib/agent/security'

let root: string

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'agent-basename-'))
  await mkdir(path.join(root, 'lib', 'agent'), { recursive: true })
  await mkdir(path.join(root, 'components'), { recursive: true })
  await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true })
  await mkdir(path.join(root, '.next', 'static'), { recursive: true })

  // 唯一命名，可被安全解析
  await writeFile(path.join(root, 'lib', 'agent', 'prompt.ts'), 'x')
  await writeFile(path.join(root, 'components', 'fileLink.tsx'), 'x')

  // 同名两处 → 必须返回歧义
  await writeFile(path.join(root, 'lib', 'agent', 'index.ts'), 'x')
  await writeFile(path.join(root, 'components', 'index.ts'), 'x')

  // 敏感文件：绝不出现在候选里
  await writeFile(path.join(root, '.env'), 'SECRET=1')

  // 忽略目录里的同名文件：不应被计入
  await writeFile(path.join(root, 'node_modules', 'pkg', 'unique-name.ts'), 'x')
  await writeFile(path.join(root, '.next', 'static', 'build-only.ts'), 'x')
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

test('唯一命中时返回该相对路径', async () => {
  const found = await findFilesByBasename({ workspaceRoot: root, basename: 'prompt.ts' })
  assert.deepEqual(found, ['lib/agent/prompt.ts'])
})

test('嵌套目录下的文件能被找到', async () => {
  const found = await findFilesByBasename({ workspaceRoot: root, basename: 'fileLink.tsx' })
  assert.deepEqual(found, ['components/fileLink.tsx'])
})

test('同名多处时返回全部候选（不替调用方挑一个）', async () => {
  const found = await findFilesByBasename({ workspaceRoot: root, basename: 'index.ts' })
  assert.equal(found.length, 2)
  assert.ok(found.includes('lib/agent/index.ts'))
  assert.ok(found.includes('components/index.ts'))
})

test('敏感文件不出现在候选里', async () => {
  const found = await findFilesByBasename({ workspaceRoot: root, basename: '.env' })
  assert.deepEqual(found, [], '.env 绝不能被"搜索"解析出来，否则护栏形同虚设')
})

test('忽略目录里的文件不参与搜索', async () => {
  const inNodeModules = await findFilesByBasename({ workspaceRoot: root, basename: 'unique-name.ts' })
  assert.deepEqual(inNodeModules, [], 'node_modules 不应被遍历')

  const inNext = await findFilesByBasename({ workspaceRoot: root, basename: 'build-only.ts' })
  assert.deepEqual(inNext, [], '.next 不应被遍历')
})

test('不存在的文件名返回空数组', async () => {
  const found = await findFilesByBasename({ workspaceRoot: root, basename: 'nope.ts' })
  assert.deepEqual(found, [])
})

test('传入带路径的字符串时直接返回空（避免把片段当文件名搜）', async () => {
  for (const bad of ['lib/agent/prompt.ts', 'lib\\agent\\prompt.ts', '..', '.', '']) {
    const found = await findFilesByBasename({ workspaceRoot: root, basename: bad })
    assert.deepEqual(found, [], `不应对 ${JSON.stringify(bad)} 做搜索`)
  }
})

test('maxResults 生效，候选数量受控', async () => {
  const found = await findFilesByBasename({ workspaceRoot: root, basename: 'index.ts', maxResults: 1 })
  assert.equal(found.length, 1)
})
