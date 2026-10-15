// lib/agent/revert.ts
// 回滚一个已应用的提案。
// 为什么不需要新数据库列、不需要存原文：
//   unified diff 是可逆的代数 —— 交换 @@ 两侧的行号、互换 +/- 就得到
//   「撤销这份改动」的补丁。原文是从**当前磁盘内容 + 反转 hunk** 现算出来的，
//   所以不存在「库里存的原文和磁盘不一致」这一类问题。
//
// 为什么闸门比 apply 更严：
//   apply 是「用户明确批准了这份 diff」，回滚是「把用户已经接受的现实改回去」。
//   后者猜错的代价更大（会覆盖用户应用之后的再编辑），所以这里的规则是
//   **宁可拒绝，也不猜**。
import { rm } from 'node:fs/promises'
import { getWorkspaceRoot, resolveWorkspaceFile } from './security'
import {
  buildTargetFiles,
  parseFilePatches,
  renderUnifiedDiff,
  reverseFilePatch,
} from './patch'
import {
  EMPTY_FILE_SHA256,
  hashWorkspaceFiles,
  readWorkspaceFileOrNull,
  workspaceIdForCurrentCheckout,
} from './workspace'
import { writeAtomically } from './atomicWrite'
import { logEvent } from '@/lib/logging'

export type RevertOutcome =
  | { ok: true; revertedFiles: string[]; deletedFiles: string[] }
  | {
    ok: false
    code:
    | 'PROPOSAL_NOT_APPLIED'
    | 'WORKSPACE_CHANGED'
    | 'HUNK_CONTEXT_MISMATCH'
    | 'INTERNAL_ERROR'
    message: string
  }

/**
 * 把一份 applied 的提案撤回到应用前的内容。
 *
 * 闸门顺序：
 *   状态必须是 applied（reverted 由路由层幂等处理，这里当错误）
 *   工作区必须还是同一个 checkout
 *   摘出「正向新增的文件」——它们的回滚是删除，不能进反转 diff
 *   反转 diff + 当前磁盘内容 → 原文；上下文不匹配就拒绝（这是回滚的安全阀）
 *   原子写回，失败已由 writeAtomically 全量回滚
 *   写后校验：磁盘 hash 必须等于 baseFileHashes[path]
 *   删除新增文件（放在最后，见下）
 */
export async function revertAppliedProposal(input: {
  proposalId: string
  userId: string
}): Promise<RevertOutcome> {
  const { getProposalForUser, markProposalReverted } = await import(
    '@/lib/repositories/proposalRepository'
  )

  try {
    const proposal = await getProposalForUser(input.proposalId, input.userId)
    if (!proposal) {
      return { ok: false, code: 'PROPOSAL_NOT_APPLIED', message: '提案不存在或不属于该用户' }
    }

    // 只有 applied 能回滚
    if (proposal.status !== 'applied') {
      return {
        ok: false,
        code: 'PROPOSAL_NOT_APPLIED',
        message: `提案当前状态为 ${proposal.status}，只有 applied 的提案才能回滚`,
      }
    }

    // 同一个 checkout 才谈得上回滚
    if (proposal.workspaceId !== workspaceIdForCurrentCheckout()) {
      return {
        ok: false,
        code: 'WORKSPACE_CHANGED',
        message: '这份提案是在另一个工作区应用的，拒绝按它的 diff 回滚',
      }
    }

    const parsed = parseFilePatches(proposal.diff)
    if (!parsed.ok) {
      return {
        ok: false,
        code: 'INTERNAL_ERROR',
        message: `库里的 diff 无法解析（${parsed.code}）：${parsed.message}`,
      }
    }

    // 摘出正向新增的文件。
    //    isNew 是主信号；baseFileHashes === EMPTY_FILE_SHA256 是交叉验证
    //    （提案创建时缺失的文件按空文件 hash 记账）。
    const baseHashes = (proposal.baseFileHashes ?? {}) as Record<string, string>
    const createdPaths = new Set(
      parsed.files
        .filter((f) => f.isNew || baseHashes[f.path] === EMPTY_FILE_SHA256)
        .map((f) => f.path),
    )
    const modifiedFiles = parsed.files.filter((f) => !createdPaths.has(f.path))

    const revertedFiles: string[] = []
    const deletedFiles: string[] = []

    // 改回原文
    if (modifiedFiles.length > 0) {
      const contents: Record<string, string> = {}
      for (const file of modifiedFiles) {
        const text = await readWorkspaceFileOrNull(file.path)
        if (text === null) {
          return {
            ok: false,
            code: 'WORKSPACE_CHANGED',
            message: `文件已不存在：${file.path}（应用之后被删掉了，无法回滚）`,
          }
        }
        contents[file.path] = text
      }

      const reversedDiff = renderUnifiedDiff(modifiedFiles.map(reverseFilePatch))
      const built = buildTargetFiles(reversedDiff, contents)

      if (!built.ok) {
        // 这里是回滚最关键的失败分支：当前内容不是「这份 diff 的目标态」，
        // 说明用户在应用之后又改过这些文件 —— 绝不能硬写回去。
        return {
          ok: false,
          code: built.code === 'HUNK_CONTEXT_MISMATCH' ? 'HUNK_CONTEXT_MISMATCH' : 'INTERNAL_ERROR',
          message: `当前工作区内容与这份 diff 的目标态不一致，拒绝回滚：${built.message}`,
        }
      }

      // 原子写回（与 apply 共用同一套护栏）
      const written = await writeAtomically(built.plans, (relativePath) =>
        resolveWorkspaceFile(getWorkspaceRoot(), relativePath),
      )
      if (!written.ok) {
        return { ok: false, code: 'INTERNAL_ERROR', message: `回滚写盘失败：${written.message}` }
      }

      // 写后校验：磁盘内容必须真的回到 baseFileHashes 记录的那一版
      const afterHashes = await hashWorkspaceFiles(built.plans.map((p) => p.path))
      const mismatched = built.plans.filter(
        (plan) => baseHashes[plan.path] && afterHashes[plan.path] !== baseHashes[plan.path],
      )
      if (mismatched.length > 0) {
        logEvent('error', 'agent.revertVerifyFailed', {
          proposalId: proposal.id,
          files: mismatched.map((p) => p.path),
        })
        return {
          ok: false,
          code: 'INTERNAL_ERROR',
          message: `回滚写后校验失败：${mismatched.map((p) => p.path).join(', ')}`,
        }
      }

      revertedFiles.push(...built.plans.map((p) => p.path))
    }

    // 删除正向新增的文件。
    //    为什么放在写回**之后**：写回失败时 writeAtomically 已经全量回滚，工作区完好；
    //    而删除失败只留下一个「多出来的新文件」——用户看得见、能自己删（rm 是原子的）。
    //    V1 的取舍：真正全原子的做法要扩展 writeAtomically 支持 delete op，
    //    那属于 Day 29。
    for (const relativePath of createdPaths) {
      const abs = await resolveWorkspaceFile(getWorkspaceRoot(), relativePath)
      await rm(abs, { force: true })
      deletedFiles.push(relativePath)
    }

    // 状态收口。改不到说明并发下已被别人回滚过 —— 内容已经恢复，不算失败。
    const marked = await markProposalReverted(proposal.id)
    if (!marked) {
      logEvent('warn', 'agent.revertStateRace', { proposalId: proposal.id, userId: input.userId })
    }

    logEvent('info', 'agent.revertSuccess', {
      proposalId: proposal.id,
      userId: input.userId,
      revertedFiles,
      deletedFiles,
      diffHash: proposal.diffHash,
    })
    return { ok: true, revertedFiles, deletedFiles }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logEvent('error', 'agent.revertFailed', { proposalId: input.proposalId, error: message })
    return { ok: false, code: 'INTERNAL_ERROR', message }
  }
}