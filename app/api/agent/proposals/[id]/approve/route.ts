// app/api/agent/proposals/[id]/approve/route.ts
//
// 批准 / 拒绝提案。
//
// 为什么批准要单独成接口，而不是靠 AI SDK 的工具审批：
//   工具审批（needsApproval）确认的是"允许模型调用这个工具"，
//   要求审批**绑定到具体的 diff**（diffHash + 基线 hash）。
//   批准必须发生在用户看到 Diff 与风险之后，属于提案生命周期，不是一次工具调用。
//   两者不是替代关系：本接口记录批准，applyApprovedPatch 工具负责执行。
import { requireUserId } from '@/lib/api/auth'
import { withApiLogging, getRequestId } from '@/lib/api/observability'
import { approveProposal, getProposalForUser, rejectProposal } from '@/lib/repositories/proposalRepository'
import { logEvent } from '@/lib/logging'

const DECISIONS = new Set(['approve', 'reject'])

export const POST = withApiLogging({
  event: 'agent.proposal.approve',
  handler: async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const requestId = getRequestId(req)
    const userId = await requireUserId()
    const { id } = await params

    let payload: { decision?: unknown; reason?: unknown }
    try {
      payload = (await req.json()) as { decision?: unknown; reason?: unknown }
    } catch {
      return Response.json({ error: 'INVALID_INPUT', message: '请求体不是合法 JSON', requestId }, { status: 400 })
    }

    const decision = typeof payload.decision === 'string' ? payload.decision : ''
    if (!DECISIONS.has(decision)) {
      return Response.json(
        { error: 'INVALID_INPUT', message: "decision 必须是 'approve' 或 'reject'", requestId },
        { status: 400 },
      )
    }

    // 取提案：不存在/不属于该用户 → 404（不区分，避免泄漏存在性）
    const proposal = await getProposalForUser(id, userId)
    if (!proposal) {
      return Response.json({ error: 'NOT_FOUND', requestId }, { status: 404 })
    }

    // 过期检查：过期就不该能批准（否则用户会批准一个基线已失效的提案）
    if (proposal.expiresAt.getTime() < Date.now()) {
      return Response.json(
        { error: 'PROPOSAL_EXPIRED', message: '提案已过期，请让 Agent 重新生成', requestId },
        { status: 409 },
      )
    }

    if (decision === 'reject') {
      const res = await rejectProposal({
        proposalId: id,
        userId,
        reason: typeof payload.reason === 'string' ? payload.reason : undefined,
      })
      if (!res.ok) {
        return Response.json({ error: 'CONFLICT', message: res.reason, requestId }, { status: 409 })
      }
      return Response.json({ status: 'rejected', requestId })
    }

    const res = await approveProposal({
      proposalId: id,
      userId,
      // 批准的是**这份** diff：记下此刻的 diffHash
      diffHash: proposal.diffHash,
    })
    if (!res.ok) {
      if (proposal.status === 'approved' && proposal.approvedDiffHash === proposal.diffHash) {
        logEvent('info', 'agent.proposalApproveIdempotent', { requestId, proposalId: id, userId })
        return Response.json({
          status: 'approved',
          alreadyApproved: true,
          diffHash: proposal.diffHash,
          requestId,
        })
      }
      return Response.json({ error: 'CONFLICT', message: res.reason, requestId }, { status: 409 })
    }
    logEvent('info', 'agent.proposalApproveRequested', { requestId, proposalId: id, userId })
    return Response.json({ status: 'approved', diffHash: proposal.diffHash, requestId })
  },
})