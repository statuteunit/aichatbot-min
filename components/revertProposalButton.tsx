'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

export function RevertProposalButton({ proposalId }: { proposalId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  // 回滚成功后自己记住结果：消息里的工具 part 与详情页都不会因此重渲染，
  // 不记住的话按钮会一直显示"回滚这次改动"，用户会以为没生效而反复点。
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (done) {
    return <p className="text-xs text-gray-500">已回滚：改过的文件已恢复到应用前的内容。</p>
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          // 回滚会覆盖工作区内容，必须二次确认（apply 也有同样的确认闸门）
          if (!window.confirm('回滚会把这份提案改过的文件恢复到应用前的内容，新增的文件会被删除。继续？')) {
            return
          }
          setBusy(true)
          setError(null)
          try {
            const res = await fetch(
              `/api/agent/proposals/${encodeURIComponent(proposalId)}/revert`,
              { method: 'POST' },
            )
            const body = (await res.json().catch(() => null)) as { message?: string } | null
            if (!res.ok) {
              setError(body?.message ?? `回滚失败（HTTP ${res.status}）`)
              return
            }
            setDone(true)
            // 服务端组件重新取数：详情页的状态徽章、时间线随之更新
            // （在对话页里也安全：router.refresh 只重取 RSC 数据，不会重置客户端 state）
            router.refresh()
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
          } finally {
            setBusy(false)
          }
        }}
        className="rounded-md border border-red-300 bg-white px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
      >
        {busy ? '回滚中…' : '回滚这次改动'}
      </button>
      {/* 一条消息可能应用了多份提案，标出 id 前缀才分得清是哪一个 */}
      <span className="ml-2 align-middle font-mono text-[10px] text-gray-500">
        {proposalId.slice(0, 8)}
      </span>
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
    </div>
  )
}