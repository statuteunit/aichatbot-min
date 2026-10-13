// lib/agent/atomicWrite.ts
//
// 落盘原子性的**唯一**实现点。
//
// 为什么单独成文件，而不是留在 apply.ts 里：
//   ① apply.ts 里的 writeAtomically 不导出 —— 导出了也没用，因为 apply.ts 会
//      间接拉进 Prisma（proposalRepository）与 server-only 依赖，node:test 引不动。
//      于是 tests/agent/apply.test.ts 只能**自己复制一遍写入逻辑**，
//      那种测试永远发现不了原子性与回滚缺陷（它测的是自己抄的那份）。
//   ② 把"写盘"和"批准状态机"分开：状态机需要数据库，写盘不需要。
//      分开之后测试可以在真实临时目录上验证 rename 的原子性与失败回滚。
//
// 本文件**刻意不引入任何项目内依赖**（不 import logging、不 import security）：
//   - 工作区根与路径护栏由调用方（apply.ts）负责，本文件只做"给我绝对路径，我保证
//     要么全部写好、要么回到原样"这一件事；
//   - 唯一需要的类型 PatchFilePlan 用 `import type`，编译后完全消失，不产生循环依赖；
//   - 因此 node:test 可以零配置直接 import 本文件。
//
// 不做 git apply / git worktree 的原因见 apply.ts 文件头。
import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PatchFilePlan } from './patch'

export type AtomicWriteResult = { ok: true } | { ok: false; message: string }

/**
 * 把一批文件写进工作区，任一步失败就回滚已写的部分。
 *
 * 为什么先全部写临时文件、再统一 rename：
 *   ① 临时文件阶段任何失败都还没动过真实文件 —— 不需要回滚；
 *   ② rename 阶段每步失败都已改动过真实文件 —— 用 originalContent 回滚。
 * 两段分开，把"需要回滚"的窗口压到最短。
 *
 * @param plans      每个文件的目标内容，以及**回滚所需的原文**（originalContent）
 * @param resolveAbs 相对路径 → 绝对路径。由调用方注入，好处是：
 *                   - 本文件不需要知道 AGENT_WORKSPACE_ROOT 与路径护栏；
 *                   - 测试可以注入"第二个文件解析失败"来稳定地验证回滚
 *                     （否则要制造一个"临时文件写得进去、rename 失败"的场景，
 *                      那种场景与文件系统实现强耦合，做不干净）。
 */
export async function writeAtomically(
  plans: readonly PatchFilePlan[],
  resolveAbs: (relativePath: string) => Promise<string>,
): Promise<AtomicWriteResult> {
  // 路径 → 临时文件路径。用 path 而不是 plan 对象做 key：
  // path 在一次 apply 内唯一，且不依赖"循环变量与 plans 元素是同一引用"这一隐含前提
  // （按引用配对时，一旦 plans 被 map/展开过就会静默失配成 undefined）。
  const tempPathByPath = new Map<string, string>()

  // 尚未被 rename 消耗、因此还留在磁盘上的临时文件。rename 成功后必须从这里移除，
  // 否则失败清理会去删一个已经不存在的路径（force:true 不报错，但清单语义已经错了）。
  const pendingTemps = new Set<string>()

  // 已经 rename 成功的 plan —— 回滚只针对这些，不能多也不能少。
  const written: PatchFilePlan[] = []

  try {
    // 阶段一：全部落成**兄弟临时文件**（同目录 ⇒ 同一文件系统 ⇒ rename 才是原子的）。
    // 不用 `.agent-tmp/` 子目录：
    //   ① 子目录引入"目录本身也要清理"这一额外失败面（原代码的 dir 变量就死在这一点上）；
    //   ② 同目录 rename 天然满足原子性，不需要"临时目录与目标在同一文件系统"这一假设。
    for (const plan of plans) {
      const abs = await resolveAbs(plan.path)
      const ext = path.extname(abs)                       // '.ts' / '.tsx' / ''
      const base = abs.slice(0, abs.length - ext.length)  // 去掉扩展名的绝对路径
      const tempPath = `${base}.agent-${randomUUID()}.tmp`
      await writeFile(tempPath, plan.targetContent, 'utf8')
      tempPathByPath.set(plan.path, tempPath)
      pendingTemps.add(tempPath)
    }

    // 阶段二：逐个 rename。rename 成功后临时文件即被消耗（路径不复存在），
    // 所以成功路径不会留下任何 `.agent-tmp/` 或 `*.tmp`。
    for (const plan of plans) {
      const abs = await resolveAbs(plan.path)
      const tempPath = tempPathByPath.get(plan.path)
      // 这个分支理论上不可达（阶段一必然为每个 plan 建好映射）。
      // 之所以仍然 throw 而不是 continue：宁可整体失败回滚，
      // 也不能"跳过某个文件"留下一个只改了一半的工作区。
      if (!tempPath) throw new Error(`缺少临时文件映射：${plan.path}`)

      await rename(tempPath, abs)
      written.push(plan)
      pendingTemps.delete(tempPath)
    }

    return { ok: true }
  } catch (err) {
    // 失败路径分两步，顺序不能反：
    //   ① 先把已经 rename 的文件按 originalContent 回滚（这是唯一"真实文件被改过"的部分）；
    //   ② 再删掉还没 rename 的临时文件（纯清理，失败也不影响正确性）。
    await rollbackPlans(written, resolveAbs)

    for (const tempPath of pendingTemps) {
      try {
        await rm(tempPath, { force: true })
      } catch {
        // 清理失败不能掩盖主错误：临时文件残留是可接受的降级，
        // 而丢掉 err.message 会让"为什么没应用成功"变得无法排查。
      }
    }

    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 用内存里的原文恢复一批文件。
 *
 * 回滚的依据是 plan.existsBefore / plan.originalContent 这一对：
 *   existsBefore 为 true  → 把 originalContent 写回去
 *   existsBefore 为 false → 删除该文件（新增文件的"回滚"是删除，不是写一个空文件）
 *
 * 注意：这里的写回也是原子的（临时文件 + rename）。
 * 早先的实现直接用 writeFile —— 回滚本身被中断会留下截断文件，
 * 那比不回滚更糟：用户看到的是一个既不是原文、也不是目标态的中间产物。
 */
export async function rollbackPlans(
  plans: readonly PatchFilePlan[],
  resolveAbs: (relativePath: string) => Promise<string>,
): Promise<void> {
  for (const plan of plans) {
    try {
      const abs = await resolveAbs(plan.path)
      if (plan.existsBefore) {
        await writeFileAtomically(abs, plan.originalContent)
      } else {
        // 原本不存在 → 回滚就是把它删掉
        await rm(abs, { force: true })
      }
    } catch (err) {
      // 本文件不 import 项目内的 logging（见文件头：保持零依赖，便于测试直接引用），
      // 所以这里用与 lib/logging.ts 的 logEvent 完全一致的 JSON 结构手写一行。
      // 字段形状必须保持一致，否则 trace 聚合脚本会漏掉这条。
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: 'error',
          event: 'agent.rollbackFailed',
          path: plan.path,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    }
  }
}

/**
 * 单文件的原子写：先写兄弟临时文件，再 rename 覆盖目标。
 *
 * 与 writeFile 的差别在失败时：
 *   writeFile  失败 → 目标文件可能已被截断（内容既非旧也非新）
 *   本函数     失败 → 目标文件保持原样（要么旧内容，要么完整新内容）
 */
export async function writeFileAtomically(absPath: string, content: string): Promise<void> {
  await mkdir(path.dirname(absPath), { recursive: true })
  const ext = path.extname(absPath)
  const base = absPath.slice(0, absPath.length - ext.length)
  const tempPath = `${base}.agent-${randomUUID()}.tmp`
  try {
    await writeFile(tempPath, content, 'utf8')
    await rename(tempPath, absPath)
  } catch (err) {
    // 失败时尽量清掉临时文件，但不能因此吞掉真实错误
    await rm(tempPath, { force: true }).catch(() => {})
    throw err
  }
}
