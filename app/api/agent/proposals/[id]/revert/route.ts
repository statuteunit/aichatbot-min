import { getRequestId, withApiLogging } from '@/lib/api/observability'
import { requireUserId } from '@/lib/api/auth'
import { logEvent } from '@/lib/logging'
import { getProposalForUser } from '@/lib/repositories/proposalRepository'
import { revertAppliedProposal } from '@/lib/agent/revert'

export const POST = withApiLogging({
  event: 'agent.proposal.revert',
  handler: async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const requestId = getRequestId(req)
    const userId = await requireUserId()
    const { id } = await params

    const proposal = await getProposalForUser(id, userId)
    if (!proposal) {
      // 与 GET/approve 一致：不区分「不存在」与「不是你的」，避免探测
      return Response.json({ error: 'NOT_FOUND', requestId }, { status: 404 })
    }

    // 幂等：已经回滚过就直接 200。
    // 用户可能连点两次，或在响应丢失后重试 —— 这两种情况都不该报错。
    if (proposal.status === 'reverted') {
      logEvent('info', 'agent.proposalRevertIdempotent', { requestId, proposalId: id, userId })
      return Response.json({ status: 'reverted', alreadyReverted: true, requestId })
    }

    const outcome = await revertAppliedProposal({ proposalId: id, userId })
    if (!outcome.ok) {
      // 全部按 409 返回：都是「当前状态不允许这个操作」，语义上不是请求格式错
      return Response.json(
        { error: outcome.code, message: outcome.message, requestId },
        { status: 409 },
      )
    }

    logEvent('info', 'agent.proposalReverted', {
      requestId,
      proposalId: id,
      userId,
      revertedFiles: outcome.revertedFiles.length,
      deletedFiles: outcome.deletedFiles.length,
    })
    return Response.json({
      status: 'reverted',
      revertedFiles: outcome.revertedFiles,
      deletedFiles: outcome.deletedFiles,
      requestId,
    })
  },
})