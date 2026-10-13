// lib/agent/apply.ts
// ⚠️ 这是整个项目**唯一**会改写用户 checkout 的文件。改动它必须同时回答：
//    失败时会不会留下半改状态？  → 兄弟临时文件 + rename，且失败时全量回滚
//    重复执行会不会重复写？      → 对比磁盘 hash 与 targetHash（幂等）
//    基线变了怎么办？            → 重新算 baseFileHashes，不符即拒绝并标 stale
//    批准的是不是这份 diff？      → 校验 approvedDiffHash === diffHash
//
// 落盘机制已经拆到 lib/agent/atomicWrite.ts —— 那不是为了"拆文件好看"，而是因为
// writeAtomically 不导出时，测试只能自己抄一遍写入逻辑，从而永远测不到原子性与回滚。
//
// 不做 git apply / git worktree 的原因：
//    lib/agent/exec.ts 的 ALLOWED_GIT_SUBCOMMANDS 只有 log/diff/status/show，
//    刻意不含 apply/checkout/commit。要扩白名单就要同时扩审计与审批面，
//    V1 不做。自己 write+rename 的原子性依赖于同一文件系统，而这是成立的
//    —— 临时文件与目标文件在同一目录下。
import { getWorkspaceRoot, resolveWorkspaceFile } from './security'
import { buildTargetFiles, type PatchRejectionCode } from './patch'
import { hashWorkspaceFiles, workspaceIdForCurrentCheckout } from './workspace'
import { logEvent } from '@/lib/logging'
import { writeAtomically, rollbackPlans } from './atomicWrite'

export interface ApplyRejection {
  ok: false
  code:
  | PatchRejectionCode
  | 'PROPOSAL_NOT_APPROVED'
  | 'PROPOSAL_EXPIRED'
  | 'WORKSPACE_CHANGED'
  | 'INTERNAL_ERROR'
  message: string
  /** 可展示给用户的冲突明细（哪个文件变了） */
  conflicts?: { path: string; expected: string; actual: string }[]
}

export interface ApplySuccess {
  ok: true
  appliedFiles: string[]
  /** 每个文件应用后的内容 hash，写入 PatchProposal.targetFileHashes */
  targetFileHashes: Record<string, string>
  /** true = 磁盘已是目标状态，本次没有写任何文件（重复批准） */
  idempotent: boolean
}

export type ApplyOutcome = ApplySuccess | ApplyRejection

export interface ApplyProposalInput {
  proposalId: string
  /** 审批人的用户 id，用于审计 */
  userId: string
}

/**
 * 工作区标识校验。
 * 提案记录的 workspaceId 与当前 checkout 不一致时拒绝 ——
 * 提案是在另一个工作区生成的，它的基线 hash 在这里没有意义。
 */
function workspaceMatches(proposal: { workspaceId: string }): boolean {
  return proposal.workspaceId === workspaceIdForCurrentCheckout()
}

/**
 * 把相对路径解析成绝对路径，并在解析时跑完路径护栏（穿越 / 敏感文件 / 忽略目录）。
 *
 * 为什么作为参数注入 writeAtomically，而不是让它自己 import security：
 *   atomicWrite.ts 保持零项目依赖（见该文件头），测试才能直接引用它；
 *   而"哪些路径允许写"是 apply 这一层的策略，不该混进写入机制里。
 */
function resolveAbsInWorkspace(relativePath: string): Promise<string> {
  return resolveWorkspaceFile(getWorkspaceRoot(), relativePath)
}

/**
 * 应用一个已批准的提案。
 *
 * 调用方必须已经完成"批准"（PatchProposal.status === 'approved'）。
 * 本函数**不负责批准** —— 批准是用户动作，应用是执行动作，两者必须分开，
 * 否则"批准"会退化成"应用时的副作用"，审计就断链了。
 */
export async function applyApprovedPatch(input: ApplyProposalInput): Promise<ApplyOutcome> {
  const { getProposalForUser, markProposalStale, markProposalApplied, markProposalFailed } = await import(
    '@/lib/repositories/proposalRepository'
  )

  const proposal = await getProposalForUser(input.proposalId, input.userId)
  if (!proposal) {
    return { ok: false, code: 'PROPOSAL_NOT_APPROVED', message: '提案不存在或不属于该用户' }
  }

  // ① 状态与有效期
  if (proposal.status !== 'approved') {
    return {
      ok: false,
      code: 'PROPOSAL_NOT_APPROVED',
      message: `提案当前状态为 ${proposal.status}，只有 approved 的提案才能应用`,
    }
  }
  if (proposal.expiresAt.getTime() < Date.now()) {
    await markProposalStale(proposal.id)
    return { ok: false, code: 'PROPOSAL_EXPIRED', message: '提案已过期，请重新生成后再批准' }
  }

  // ② 批准绑定：批准时的 diffHash 必须与当前一致
  if (!proposal.approvedDiffHash || proposal.approvedDiffHash !== proposal.diffHash) {
    // 已批准的内容与库里的 diff 不一致 → 这是篡改或写入错误，必须拒绝并留痕
    logEvent('error', 'agent.approvalHashMismatch', {
      proposalId: proposal.id,
      approvedDiffHash: proposal.approvedDiffHash,
      diffHash: proposal.diffHash,
    })
    return {
      ok: false,
      code: 'PROPOSAL_NOT_APPROVED',
      message: '提案内容在批准后发生了变化，拒绝应用。请重新审查并批准。',
    }
  }

  // ③ 工作区标识
  if (!workspaceMatches(proposal)) {
    return {
      ok: false,
      code: 'WORKSPACE_CHANGED',
      message: `提案属于工作区 ${proposal.workspaceId}，当前工作区是 ${workspaceIdForCurrentCheckout()}，拒绝应用`,
    }
  }

  // ④ 基线冲突检测：重新算一遍当前磁盘的状态
  const baseFileHashes = (proposal.baseFileHashes ?? {}) as Record<string, string>
  const targetFileHashes = (proposal.targetFileHashes ?? {}) as Record<string, string>
  const paths = Object.keys(baseFileHashes)
  const currentHashes = await hashWorkspaceFiles(paths)

  const conflicts = paths
    .filter((p) => currentHashes[p] !== baseFileHashes[p] && currentHashes[p] !== targetFileHashes[p])
    .map((p) => ({ path: p, expected: baseFileHashes[p], actual: currentHashes[p] }))

  if (conflicts.length > 0) {
    await markProposalStale(proposal.id)
    logEvent('warn', 'agent.applyConflict', { proposalId: proposal.id, conflicts: conflicts.map((c) => c.path) })
    return {
      ok: false,
      code: 'WORKSPACE_CHANGED',
      message: `${conflicts.length} 个文件在提案创建后已被修改，提案不再适用`,
      conflicts,
    }
  }

  // ⑤ 幂等：全部文件都已在目标状态 → 直接成功，一个字节都不写
  const alreadyApplied = paths.length > 0 && paths.every((p) => currentHashes[p] === targetFileHashes[p])
  if (alreadyApplied) {
    await markProposalApplied(proposal.id)
    logEvent('info', 'agent.applyIdempotent', { proposalId: proposal.id, fileCount: paths.length })
    return { ok: true, appliedFiles: [], targetFileHashes, idempotent: true }
  }

  // ⑥ 部分已应用 = 上一次写到一半（极罕见）→ 拒绝，让用户明确处理，
  //    不要"接着写完"，因为半改状态下的基线无法信任
  const partiallyApplied = paths.filter((p) => currentHashes[p] === targetFileHashes[p])
  if (partiallyApplied.length > 0) {
    await markProposalFailed(proposal.id, `部分文件已是目标状态：${partiallyApplied.join(', ')}`)
    return {
      ok: false,
      code: 'WORKSPACE_CHANGED',
      message:
        `检测到 ${partiallyApplied.length} 个文件已处于目标状态、其余仍为基线，` +
        '疑似上次应用中断。为避免产生不一致的结果，请先人工核对这几个文件。',
      conflicts: partiallyApplied.map((p) => ({ path: p, expected: baseFileHashes[p], actual: currentHashes[p] })),
    }
  }

  // ⑦ 在内存里重建目标内容（内容层面的冲突在这里会被发现）
  const baseContents: Record<string, string> = {}
  for (const p of paths) {
    const text = await readWorkspaceText(p)
    if (text !== null) baseContents[p] = text
  }
  const built = buildTargetFiles(proposal.diff, baseContents)
  if (!built.ok) {
    // 上下文不符属于"基线已变"，标 stale；其余是提案本身有问题，标 failed
    if (built.code === 'HUNK_CONTEXT_MISMATCH' || built.code === 'HUNK_RANGE_INVALID') {
      await markProposalStale(proposal.id)
    } else {
      await markProposalFailed(proposal.id, built.message)
    }
    return { ok: false, code: built.code, message: built.message }
  }

  // ⑧ 落盘
  const writeResult = await writeAtomically(built.plans, resolveAbsInWorkspace)
  if (!writeResult.ok) {
    await markProposalFailed(proposal.id, writeResult.message)
    logEvent('error', 'agent.applyFailed', { proposalId: proposal.id, error: writeResult.message })
    return { ok: false, code: 'INTERNAL_ERROR', message: `写入失败且已回滚：${writeResult.message}` }
  }

  // ⑨ 写后校验：读回来比对 hash，确认磁盘真的是目标状态
  const verified = await hashWorkspaceFiles(built.plans.map((p) => p.path))
  const mismatched = built.plans.filter((p) => verified[p.path] !== p.targetHash).map((p) => p.path)
  if (mismatched.length > 0) {
    // 写后校验失败说明文件系统行为异常，必须回滚
    logEvent('error', 'agent.applyVerifyFailed', { proposalId: proposal.id, paths: mismatched })
    await rollbackPlans(built.plans, resolveAbsInWorkspace)
    await markProposalFailed(proposal.id, `写后校验失败：${mismatched.join(', ')}`)
    return { ok: false, code: 'HUNK_CONTEXT_MISMATCH', message: `写后校验失败并已回滚：${mismatched.join(', ')}` }
  }

  await markProposalApplied(proposal.id)
  logEvent('info', 'agent.applySuccess', {
    proposalId: proposal.id,
    fileCount: built.plans.length,
    files: built.plans.map((p) => p.path),
    diffHash: proposal.diffHash,
  })
  return {
    ok: true,
    appliedFiles: built.plans.map((p) => p.path),
    targetFileHashes: Object.fromEntries(built.plans.map((p) => [p.path, p.targetHash])),
    idempotent: false,
  }
}

/** 读工作区里的文本内容；不存在返回 null */
async function readWorkspaceText(relativePath: string): Promise<string | null> {
  const { readWorkspaceFileOrNull } = await import('./workspace')
  return readWorkspaceFileOrNull(relativePath)
}

