// app/api/agent/runs/[id]/proposals/route.ts
// 列出某个 run 下的全部提案。
import { requireUserId } from '@/lib/api/auth'
import { withApiLogging, getRequestId } from '@/lib/api/observability'
import { listProposalsForRun, markExpiredProposalsStale } from '@/lib/repositories/proposalRepository'

export const GET = withApiLogging({
  event: 'agent.run.proposals.GET',
  handler: async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const requestId = getRequestId(req)
    const userId = await requireUserId()
    const { id: runId } = await params

    // 先惰性过期，保证返回的 status 是当前的
    await markExpiredProposalsStale(runId)

    const proposals = await listProposalsForRun(runId, userId)
    // 不属于该用户的 run 会返回空数组 —— 与"没有提案"不可区分，避免泄漏存在性
    return Response.json({ proposals, requestId })
  },
})