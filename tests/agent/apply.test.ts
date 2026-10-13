// tests/agent/apply.test.ts
//
// 这个文件用真实临时目录测落盘、幂等与回滚。
// 为什么不用 mock：原子性与回滚的正确性恰恰取决于真实文件系统的行为
//（rename 的原子性、rm 的容错），mock 掉就测不到真正重要的东西。
//
// 上一版这里犯过一个更隐蔽的错：它**自己复制了一遍写入逻辑**
//   await writeFile(path.join(root, 'a.ts'), res.plans[0].targetContent, 'utf8')
// 于是它测的是"自己抄的那份"，无论 writeAtomically 有多少缺陷它都会绿。
// 现在改成直接调用真实的 writeAtomically（从 lib/agent/atomicWrite.ts 导出）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { writeAtomically } from '../../lib/agent/atomicWrite'
import { sha256 } from '../../lib/agent/workspace'
import type { PatchFilePlan } from '../../lib/agent/patch'

async function withTempWorkspace(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-apply-'))
  const prev = process.env.AGENT_WORKSPACE_ROOT
  process.env.AGENT_WORKSPACE_ROOT = root
  try {
    await fn(root)
  } finally {
    if (prev === undefined) delete process.env.AGENT_WORKSPACE_ROOT
    else process.env.AGENT_WORKSPACE_ROOT = prev
    await rm(root, { recursive: true, force: true })
  }
}

/**
 * 解析器：默认把相对路径接到临时工作区根上。
 * 测原子写为什么要注入这个？因为"哪些路径允许写"是 apply 层的策略，
 * 不属于写入机制；注入之后测试才能**确定地**让第 N 个文件在 rename 阶段失败，
 * 否则要人为制造"临时文件写得进去、rename 却失败"的场景，那种场景与
 * 文件系统实现强耦合（Windows 上 rename 覆盖已存在文件本来就成功），做不干净。
 */
function resolverFor(root: string) {
  return async (relativePath: string) => path.join(root, relativePath)
}

const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-a
+b
`

test('apply 写盘后文件内容等于期望值（用 buildTargetFiles + 真实 writeAtomically 组合验证）', async () => {
  await withTempWorkspace(async (root) => {
    await writeFile(path.join(root, 'a.ts'), 'a\n', 'utf8')
    // 注意：这里不依赖数据库 —— applyApprovedPatch 需要 Prisma，
    // 而写盘本身不需要，所以才能作为单元测试跑。
    const { buildTargetFiles } = await import('../../lib/agent/patch')
    const res = buildTargetFiles(diff, { 'a.ts': 'a\n' })
    assert.equal(res.ok, true)
    if (!res.ok) return

    const write = await writeAtomically(res.plans, resolverFor(root))
    assert.equal(write.ok, true, `写入应成功：${write.ok ? '' : write.message}`)
    assert.equal(await readFile(path.join(root, 'a.ts'), 'utf8'), 'b\n')
  })
})

test('原子写的成功路径不留下任何临时文件', async () => {
  await withTempWorkspace(async (root) => {
    await writeFile(path.join(root, 'a.ts'), 'a\n', 'utf8')
    const { buildTargetFiles } = await import('../../lib/agent/patch')
    const res = buildTargetFiles(diff, { 'a.ts': 'a\n' })
    assert.equal(res.ok, true)
    if (!res.ok) return

    const write = await writeAtomically(res.plans, resolverFor(root))
    assert.equal(write.ok, true, `写入应成功：${write.ok ? '' : write.message}`)

    // rename 会消耗掉临时文件，所以目录里只应剩目标文件本身。
    // 这条断言同时是"没有 .agent-tmp/ 子目录"的回归：子目录方案曾把
    // 临时文件放进目录，而那个目录从来没被清理过。
    const entries = await readdir(root, { recursive: true })
    assert.deepEqual(entries.sort(), ['a.ts'])
  })
})

test('rename 阶段失败时，已经写好的文件必须回滚到原文（这是原子性的核心）', async () => {
  await withTempWorkspace(async (root) => {
    await writeFile(path.join(root, 'a.ts'), 'a\n', 'utf8')
    await writeFile(path.join(root, 'b.ts'), 'b\n', 'utf8')

    const plans: PatchFilePlan[] = [
      {
        path: 'a.ts',
        existsBefore: true,
        originalContent: 'a\n',
        targetContent: 'A\n',
        baseHash: sha256('a\n'),
        targetHash: sha256('A\n'),
      },
      {
        path: 'b.ts',
        existsBefore: true,
        originalContent: 'b\n',
        targetContent: 'B\n',
        baseHash: sha256('b\n'),
        targetHash: sha256('B\n'),
      },
    ]

    // 让 b.ts 在**第二阶段**（rename 之前的那次路径解析）失败。
    // 此时 a.ts 已经被 rename 成功 —— 正是需要回滚的那个窗口。
    let calls = 0
    const result = await writeAtomically(plans, async (relativePath) => {
      calls += 1
      if (relativePath === 'b.ts' && calls > plans.length) {
        throw new Error('注入失败：rename 阶段路径解析被拒绝')
      }
      return path.join(root, relativePath)
    })

    assert.equal(result.ok, false)
    // a.ts 必须回到原文，不能停留在目标态，也不能被截断
    assert.equal(await readFile(path.join(root, 'a.ts'), 'utf8'), 'a\n')
    // b.ts 从未被改动
    assert.equal(await readFile(path.join(root, 'b.ts'), 'utf8'), 'b\n')
    // 失败路径也要清掉临时文件，否则残留物会污染 git status
    const entries = await readdir(root, { recursive: true })
    assert.deepEqual(entries.sort(), ['a.ts', 'b.ts'])
  })
})

test('临时文件阶段就失败时，真实文件一个都不能被改动', async () => {
  await withTempWorkspace(async (root) => {
    await writeFile(path.join(root, 'a.ts'), 'a\n', 'utf8')

    const plans: PatchFilePlan[] = [
      {
        path: 'a.ts',
        existsBefore: true,
        originalContent: 'a\n',
        targetContent: 'A\n',
        baseHash: sha256('a\n'),
        targetHash: sha256('A\n'),
      },
      {
        // 父目录不存在 ⇒ 写临时文件时就失败（阶段一），此时还没碰过任何真实文件
        path: 'no-such-dir/c.ts',
        existsBefore: true,
        originalContent: 'c\n',
        targetContent: 'C\n',
        baseHash: sha256('c\n'),
        targetHash: sha256('C\n'),
      },
    ]

    const result = await writeAtomically(plans, resolverFor(root))
    assert.equal(result.ok, false)
    // 阶段一失败 ⇒ 不需要回滚，a.ts 保持原文
    assert.equal(await readFile(path.join(root, 'a.ts'), 'utf8'), 'a\n')
    const entries = await readdir(root, { recursive: true })
    assert.deepEqual(entries.sort(), ['a.ts'])
  })
})

test('写后校验发现磁盘不是目标态时，rollbackPlans 能把文件恢复成原文', async () => {
  await withTempWorkspace(async (root) => {
    await writeFile(path.join(root, 'a.ts'), 'a\n', 'utf8')
    const { rollbackPlans } = await import('../../lib/agent/atomicWrite')

    // 模拟"已经应用过"的状态：磁盘是 A，而我们要回滚成 a
    await writeFile(path.join(root, 'a.ts'), 'A\n', 'utf8')
    const plan: PatchFilePlan = {
      path: 'a.ts',
      existsBefore: true,
      originalContent: 'a\n',
      targetContent: 'A\n',
      baseHash: sha256('a\n'),
      targetHash: sha256('A\n'),
    }
    await rollbackPlans([plan], resolverFor(root))

    assert.equal(await readFile(path.join(root, 'a.ts'), 'utf8'), 'a\n')
    const entries = await readdir(root, { recursive: true })
    // 回滚本身也是原子写（临时文件 + rename），所以同样不该留残留
    assert.deepEqual(entries.sort(), ['a.ts'])
  })
})

test('新增文件的回滚是删除，而不是写一个空文件', async () => {
  await withTempWorkspace(async (root) => {
    const { rollbackPlans } = await import('../../lib/agent/atomicWrite')
    await writeFile(path.join(root, 'created.ts'), 'x\n', 'utf8')

    const plan: PatchFilePlan = {
      path: 'created.ts',
      existsBefore: false, // 这个文件在改动前并不存在
      originalContent: '',
      targetContent: 'x\n',
      baseHash: sha256(''),
      targetHash: sha256('x\n'),
    }
    await rollbackPlans([plan], resolverFor(root))

    const entries = await readdir(root, { recursive: true })
    assert.deepEqual(entries, [], '新增文件回滚后目录应当是空的')
  })
})
