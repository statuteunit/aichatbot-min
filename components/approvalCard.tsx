'use client'

// components/approvalCard.tsx
//
// 工具审批卡片（Human-in-the-loop）。
//
// 背景：needsApproval: true 的工具被模型调用时，服务端**不执行**它，
// 而是发一个 tool-approval-request 并结束这一轮。用户在卡片上做决定，
// 客户端把决定写回消息；若配了 sendAutomaticallyWhen，会自动续流，
// 此时服务端才真正执行工具（或直接把拒绝理由回给模型）。
//
// 设计要点：
//   ① 参数必须展示给用户 —— 审批的意义就是让人看到"模型想干什么"。
//      但只展示**参数**，不展示未产出的结果。
//   ② 拒绝时收集理由：模型会收到这个 reason 并据此调整策略，
//      比单纯拒绝有用得多（product-spec §3.4：「用户拒绝审批 → 持久化拒绝原因；
//      提示模型不重试同一工具调用」）。
//   ③ 已决定后卡片变成只读回执，不再显示按钮 —— 防止重复提交。
import { useState } from 'react'
import { cn } from '@/lib/utils'

/** 工具审批的状态机（与 AI SDK 的 ToolUIPart.state 对应） */
export type ApprovalState =
  | 'approval-requested'
  | 'approval-responded'
  | 'output-available'
  | 'output-error'
  | 'output-denied'

export interface ApprovalCardProps {
  /** 工具展示名（已本地化，如「查看敏感文件结构」） */
  toolLabel: string
  /** 模型请求的原始参数，直接展示给用户审查 */
  input: unknown
  state: ApprovalState
  /** 已决定时由 part 带回 */
  approved?: boolean
  /** 已决定时由 part 带回 */
  reason?: string
  /** 用户做决定。不传表示当前处于只读回执状态 */
  onRespond?: (approved: boolean, reason?: string) => void
}

const STATE_LABELS: Record<ApprovalState, string> = {
  'approval-requested': '等待你批准',
  'approval-responded': '已决定，等待继续',
  'output-available': '已批准并执行',
  'output-error': '已批准但执行出错',
  'output-denied': '已拒绝',
}

/** 参数序列化：截断超长内容，避免一个巨大的 diff/文件把卡片撑爆 */
function formatInput(input: unknown): string {
  if (input === undefined) return '（无参数）'
  let text: string
  try {
    text = JSON.stringify(input, null, 2)
  } catch {
    text = String(input)
  }
  const MAX = 800
  return text.length > MAX ? `${text.slice(0, MAX)}\n…（已截断）` : text
}

export function ApprovalCard({
  toolLabel,
  input,
  state,
  approved,
  reason,
  onRespond,
}: ApprovalCardProps) {
  const [rejectionReason, setRejectionReason] = useState('')
  const [showReasonInput, setShowReasonInput] = useState(false)

  const pending = state === 'approval-requested'
  // 只有真正等用户决定时才可交互。已决定的状态一律只读。
  const interactive = pending && typeof onRespond === 'function'

  const headerTone = pending
    ? 'border-violet-300 bg-violet-50'
    : approved === false || state === 'output-denied'
      ? 'border-red-200 bg-red-50'
      : state === 'output-error'
        ? 'border-amber-300 bg-amber-50'
        : 'border-gray-200 bg-gray-50'

  return (
    <div className={cn('mt-2 rounded-lg border px-3 py-2 text-sm', headerTone)}>
      <div className="flex items-center gap-2">
        <span className="font-medium">需要批准：{toolLabel}</span>
        <span className="rounded bg-white/70 px-1.5 py-0.5 text-xs text-gray-600">
          {STATE_LABELS[state]}
        </span>
      </div>

      {/* 参数：审批的核心依据，必须展示 */}
      <div className="mt-2">
        <div className="text-xs text-gray-500 mb-1">请求参数</div>
        <pre className="max-h-40 overflow-auto rounded bg-white/80 border border-gray-200 px-2 py-1 text-xs text-gray-700 whitespace-pre-wrap break-all">
          {formatInput(input)}
        </pre>
      </div>

      {/* 已决定：显示回执 */}
      {!pending && (
        <div className="mt-2 text-xs text-gray-600">
          {approved === false
            ? '你已拒绝该操作'
            : state === 'output-denied'
              ? '你已拒绝该操作'
              : '你已批准该操作'}
          {reason ? `：${reason}` : ''}
        </div>
      )}

      {/* 待决定：操作按钮 */}
      {interactive && (
        <div className="mt-2 space-y-2">
          {showReasonInput && (
            <textarea
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              placeholder="拒绝理由（模型会看到，用来调整后续策略）"
              rows={2}
              className="w-full rounded border border-gray-300 px-2 py-1 text-xs"
            />
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onRespond?.(true)}
              className="rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-700"
            >
              批准
            </button>

            {showReasonInput ? (
              <>
                <button
                  type="button"
                  onClick={() => onRespond?.(false, rejectionReason.trim() || undefined)}
                  className="rounded bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-700"
                >
                  确认拒绝
                </button>
                <button
                  type="button"
                  onClick={() => setShowReasonInput(false)}
                  className="text-xs text-gray-500 hover:text-gray-700"
                >
                  取消
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setShowReasonInput(true)}
                className="rounded border border-gray-300 px-3 py-1 text-xs text-gray-700 hover:bg-white"
              >
                拒绝
              </button>
            )}
          </div>

          <p className="text-xs text-gray-400">
            批准后该工具才会执行；拒绝不会中断对话，模型会收到你的理由。
          </p>
        </div>
      )}
    </div>
  )
}
