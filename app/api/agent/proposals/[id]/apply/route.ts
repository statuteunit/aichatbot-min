// app/api/agent/proposals/[id]/apply/route.ts
//
// 应用已批准的提案。
//
// 幂等：重复 POST 同一个提案不会重复写入 —— 第二次会走
// lib/agent/apply.ts 的"磁盘已是目标态"分支，返回 idempotent: true。
// 所以前端不需要做防重复点击的复杂处理，接口本身是安全的。
import { requireUserId } from '@/lib/api/auth'
import { withApiLogging, getRequestId } from '@/lib/api/observability'
import { applyApprovedPatch } from '@/lib/agent/apply'

export const POST = withApiLogging({
  event: 'agent.proposal.apply',
  handler: async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const requestId = getRequestId(req)
    const userId = await requireUserId()
    const { id } = await params

    const outcome = await applyApprovedPatch({ proposalId: id, userId })

    if (!outcome.ok) {
      // 状态码映射：让前端能区分"该重新生成"与"该人工处理"
      const status =
        outcome.code === 'PROPOSAL_NOT_APPROVED' ? 409 : outcome.code === 'PROPOSAL_EXPIRED' ? 409 : 409
      return Response.json(
        { error: outcome.code, message: outcome.message, conflicts: outcome.conflicts ?? [], requestId },
        { status },
      )
    }

    return Response.json({
      appliedFiles: outcome.appliedFiles,
      targetFileHashes: outcome.targetFileHashes,
      idempotent: outcome.idempotent,
      message: outcome.idempotent
        ? '文件已是目标状态，本次未做任何写入（重复批准不会重复写入）'
        : `已应用 ${outcome.appliedFiles.length} 个文件`,
      requestId,
    })
  },
})