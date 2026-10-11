// app/api/agent/proposals/[id]/route.ts
//
// 按 id 取提案详情（含脱敏后的 Diff 预览与风险摘要）。
import { requireUserId } from '@/lib/api/auth'
import { withApiLogging, getRequestId } from '@/lib/api/observability'
import {
  getProposalForUser,
  markExpiredProposalsStale,
} from '@/lib/repositories/proposalRepository'
import { buildDiffTree, parseAndValidateDiff, renderDiffTree } from '@/lib/agent/diff'

export const GET = withApiLogging({
  event: 'agent.proposal.GET',
  handler: async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const requestId = getRequestId(req)
    const userId = await requireUserId()
    const { id } = await params

    const proposal = await getProposalForUser(id, userId)
    if (!proposal) {
      // 不存在或不属于该用户 —— 刻意不区分（避免泄漏存在性）
      return Response.json({ error: 'NOT_FOUND', requestId }, { status: 404 })
    }

    // 顺手把该 run 下已过期的 draft 标成 stale（惰性清理，见仓库层注释）
    await markExpiredProposalsStale(proposal.runId)

    // 重新解析 diff 以生成文件树。
    // 为什么不在库里存树：树是 diff 的**派生信息**，存两份必然漂移。
    // 本项目 diff 上限 500KB，解析成本可接受。
    const validation = parseAndValidateDiff(proposal.diff)
    const tree = validation.ok ? buildDiffTree(validation.parsed.files) : null

    return Response.json({
      proposal: {
        id: proposal.id,
        runId: proposal.runId,
        workspaceId: proposal.workspaceId,
        summary: proposal.summary,
        status: proposal.status,
        diffHash: proposal.diffHash,
        baseFileHashes: proposal.baseFileHashes,
        expiresAt: proposal.expiresAt,
        approvedBy: proposal.approvedBy,
        approvedAt: proposal.approvedAt,
        appliedAt: proposal.appliedAt,
        createdAt: proposal.createdAt,
        diff: proposal.diff,
      },
      // 文件树与文本渲染：前端直接用，避免各处重复实现
      tree,
      treeText: tree ? renderDiffTree(tree) : null,
      // 若库里的 diff 现在解析失败，说明入库后被人改过 —— 值得让前端看见
      diffValid: validation.ok,
      requestId,
    })
  },
})