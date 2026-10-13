// lib/agent/tools/applyPatch.ts
//
// applyApprovedPatch：把**已被用户批准**的提案应用到工作区。
//
// ⚠️ 这是整个项目唯一会改写用户 checkout 的工具
//
// 为什么工具不自己判断"能不能批准"：
//   批准必须绑定 diff 内容与基线 hash（product-spec §3.2），
//   而工具调用只携带一个 proposalId。所以：
//     批准 → 由 app/api/agent/proposals/[id]/approve 记录（带 diffHash）
//     应用 → 本工具只负责执行，apply.ts 会校验批准与基线
//   工具读库确认状态是 approved，然后就交给 apply.ts —— 单一判定点在 apply.ts。
import { z } from 'zod'
import { tool } from 'ai'
import { applyApprovedPatch } from '@/lib/agent/apply'
import { toToolErrorResult } from '@/lib/agent/security'
import { getCurrentUserId } from '@/lib/agent/runContext'

export const ApplyPatchInputSchema = z.object({
  proposalId: z.string().min(1).meta({
    description:
      '要应用的提案 id（createPatchProposal 返回的 proposalId）。' +
      '⚠️ 该提案必须已经被用户明确批准；未批准的提案会被拒绝。' +
      '提案一旦被用户改动过（基线 hash 不符）也会被拒绝。',
  }),
})

export type ApplyPatchInput = z.infer<typeof ApplyPatchInputSchema>

/**
 * needsApproval: true —— P2 语义，每次调用都要人工批准（README 权限表）。
 *
 * 这里有两层审批，看起来冗余，但含义不同：
 *   工具审批（本行）：确认"允许这次工具调用发生"
 *   提案批准（数据库 status）：确认"这份 Diff 的具体内容被接受"
 * 缺任一层都不安全：只有工具审批（本行）会让模型能直接落盘未经审查的内容；
 * 只有提案批准（数据库 status）则模型可以在用户批准 A 之后去应用 B。
 */
export const applyApprovedPatchTool = tool({
  description:
    '把一个**已被用户批准**的 patch 提案应用到工作区。' +
    '这是唯一会修改文件的工具：只有用户在看过程 Diff、风险与文件树并明确批准后才能调用。' +
    '应用是原子的：失败会回滚，不会留下改了一半的文件。重复应用同一个提案不会重复写入。',
  inputSchema: ApplyPatchInputSchema,
  needsApproval: true,
  execute: async (input) => {
    try {
      const userId = getCurrentUserId()
      if (!userId) {
        return {
          ok: false,
          code: 'INTERNAL_ERROR',
          message: '缺少用户上下文，拒绝应用（不能在没有归属的情况下改写工作区）',
        }
      }
      const outcome = await applyApprovedPatch({ proposalId: input.proposalId, userId })
      if (!outcome.ok) {
        return {
          ok: false,
          code: outcome.code,
          message: outcome.message,
          hint:
            outcome.code === 'PROPOSAL_NOT_APPROVED'
              ? '提案还没有在界面上被批准（数据库 status 仍是 draft）。请告诉用户：' +
              '在审批卡片上点「批准」—— 在聊天里用文字说"批准"不会改变任何状态。' +
              '如果用户说已经点过了，说明提案状态已被改动或已过期，' +
              '请重新读取文件并重新生成提案，不要重试本调用。'
              : outcome.code === 'WORKSPACE_CHANGED'
                ? '工作区在提案创建后变了。请重新读取相关文件、重新生成提案，不要尝试强行应用。'
                : outcome.code === 'PROPOSAL_EXPIRED'
                  ? '提案已过期，请重新生成并让用户重新批准。'
                  : '请把失败原因如实告诉用户，不要声称已经修改了文件。',
          conflicts: outcome.conflicts ?? [],
        }
      }
      return {
        ok: true,
        appliedFiles: outcome.appliedFiles,
        idempotent: outcome.idempotent,
        message: outcome.idempotent
          ? '文件已是目标状态，本次未做任何写入。'
          : `已应用 ${outcome.appliedFiles.length} 个文件：${outcome.appliedFiles.join('、')}`,
      }
    } catch (err) {
      return toToolErrorResult(err)
    }
  },
})