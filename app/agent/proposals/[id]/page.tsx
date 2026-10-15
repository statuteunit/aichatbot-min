// app/agent/proposals/[id]/page.tsx
//
// 提案详情页 —— PatchProposal.previewUrl 指向的页面。
// Server Component：
//   1. 数据已经在服务端（getProposalForUser），多一次 HTTP 往返没有收益；
//   2. 权限天然收口：拿不到就 notFound()，不存在"先渲染再判断"的窗口；
//   3. 文件树由 diff 现算，库里只存 diff。
//
// ⚠ 位置很关键：这是**页面路由**，必须放在 app/agent/... 下。
//   放到 app/api/agent/... 会和同段的 route.ts 冲突
//   （Next.js 会报 Conflicting route and page at /api/agent/proposals/[id]）。

import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { DiffView } from '@/components/diffView'
import { auth } from '@/auth'
import { buildDiffTree, parseAndValidateDiff, renderDiffTree } from '@/lib/agent/diff'
import { getProposalForUser, markExpiredProposalsStale } from '@/lib/repositories/proposalRepository'
import { RevertProposalButton } from '@/components/revertProposalButton'

export const dynamic = 'force-dynamic'

const STATUS_LABEL: Record<string, { text: string; className: string }> = {
  draft: { text: '待批准', className: 'border-amber-200 bg-amber-50 text-amber-700' },
  approved: { text: '已批准 · 待应用', className: 'border-sky-200 bg-sky-50 text-sky-700' },
  applied: { text: '已应用', className: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  rejected: { text: '已拒绝', className: 'border-gray-200 bg-gray-100 text-gray-600' },
  stale: { text: '已失效（工作区已变）', className: 'border-gray-200 bg-gray-100 text-gray-600' },
  failed: { text: '应用失败', className: 'border-red-200 bg-red-50 text-red-700' },
  reverted: { text: '已回滚', className: 'border-gray-200 bg-gray-100 text-gray-600' },
}

function formatTime(value: Date | null): string {
  return value ? new Date(value).toISOString().replace('T', ' ').slice(0, 19) : '—'
}

export default async function ProposalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user?.id) redirect(`/login?callbackUrl=/agent/proposals/${id}`)

  const proposal = await getProposalForUser(id, session.user.id)
  if (!proposal) notFound()

  // 与 API 路由同样的惰性清理：让"过期"不需要定时任务
  await markExpiredProposalsStale(proposal.runId)

  const validation = parseAndValidateDiff(proposal.diff)
  const tree = validation.ok ? buildDiffTree(validation.parsed.files) : null
  const status = STATUS_LABEL[proposal.status] ?? STATUS_LABEL.draft

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-6 py-8">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${status.className}`}>
            {status.text}
          </span>
          <span className="font-mono text-xs text-gray-500">{proposal.id}</span>
        </div>
        <h1 className="text-lg font-semibold text-gray-900">{proposal.summary}</h1>
        <p className="text-xs text-gray-500">
          工作区 {proposal.workspaceId} · diff {proposal.diffHash.slice(0, 12)} · 过期 {formatTime(proposal.expiresAt)}
        </p>
      </header>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-gray-900">文件树与改动量</h2>
        {tree ? (
          <pre className="overflow-x-auto rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs leading-5 text-gray-800">
            {renderDiffTree(tree)}
          </pre>
        ) : (
          <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            这份 diff 当前无法解析，不能应用。
          </p>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-gray-900">完整 Diff</h2>
        <DiffView diff={proposal.diff} />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-gray-900">审批与应用记录</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-gray-700">
          <dt className="text-gray-500">创建</dt>
          <dd>{formatTime(proposal.createdAt)}</dd>
          <dt className="text-gray-500">批准人</dt>
          <dd>{proposal.approvedBy ?? '—'}</dd>
          <dt className="text-gray-500">批准时间</dt>
          <dd>{formatTime(proposal.approvedAt)}</dd>
          <dt className="text-gray-500">应用时间</dt>
          <dd>{formatTime(proposal.appliedAt)}</dd>
        </dl>
      </section>

      {proposal.status === 'applied' ? <RevertProposalButton proposalId={proposal.id} /> : null}

      <p className="text-xs">
        <Link className="underline hover:text-gray-700" href="/">
          ← 返回对话
        </Link>
      </p>
    </main>
  )
}
