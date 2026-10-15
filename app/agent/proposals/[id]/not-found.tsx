// app/agent/proposals/[id]/not-found.tsx
//
// 提案不存在 / 不属于当前账号时展示。
// 与 API 路由一致：刻意不区分"不存在"和"不属于你"，避免泄漏提案的存在性。
import Link from 'next/link'

export default function ProposalNotFound() {
  return (
    <main className="mx-auto max-w-md px-6 py-20 text-center">
      <h1 className="text-base font-medium text-gray-900">找不到这份提案</h1>
      <p className="mt-2 text-sm text-gray-500">它可能已被删除，或者不属于当前账号。</p>
      <Link className="mt-6 inline-block text-sm underline" href="/">
        返回对话
      </Link>
    </main>
  )
}
