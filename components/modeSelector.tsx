'use client'

// components/modeSelector.tsx
//
// 会话模式选择器。
//
// product-spec §10 要求「coding 模式显示『提案优先、批准后编辑工作区』徽标」，
// §14 Q5 也要求「Coding 模式必须有显著权限标识」。
// 所以 coding 不只换文案，还带一条醒目的边界说明——避免用户以为它能自动改代码。
import { cn } from '@/lib/utils'
import type { ChatMode } from '@/lib/agent/prompt'

interface ModeOption {
  id: ChatMode
  label: string
  description: string
  /** 是否显示权限徽标 */
  badge?: string
}

export const MODE_OPTIONS: ModeOption[] = [
  {
    id: 'chat',
    label: '对话',
    description: '通用对话，需要时查看代码',
  },
  {
    id: 'inspector',
    label: '分析',
    description: '只读检索代码，结论必带 file:line 证据',
  },
  {
    id: 'coding',
    label: '编码',
    description: '编写改动的方案与代码块',
    badge: '提案优先 · 批准后编辑工作区',
  },
]

interface ModeSelectorProps {
  mode: ChatMode
  onModeChange: (mode: ChatMode) => void
  /**
   * 当前是否已绑定一个已落库的会话。
   * 仅用于提示文案：新会话时文案不必解释"只影响后续消息"。
   */
  hasActiveChat?: boolean
}

export function ModeSelector({ mode, onModeChange, hasActiveChat = false }: ModeSelectorProps) {
  const current = MODE_OPTIONS.find((option) => option.id === mode) ?? MODE_OPTIONS[1]

  return (
    <div className="px-4 pb-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-500">模式</span>

        <div
          role="radiogroup"
          aria-label="会话模式"
          className="inline-flex rounded-md border border-gray-300 overflow-hidden"
        >
          {MODE_OPTIONS.map((option) => {
            const active = option.id === mode
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={active}
                title={option.description}
                onClick={() => onModeChange(option.id)}
                className={cn(
                  'px-3 py-1 text-xs transition-colors cursor-pointer',
                  active ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50',
                )}
              >
                {option.label}
              </button>
            )
          })}
        </div>

        {/* coding 模式的权限徽标：product-spec §14 Q5 要求显著标识 */}
        {current.badge && (
          <span className="rounded bg-amber-50 border border-amber-200 px-2 py-0.5 text-xs text-amber-800">
            {current.badge}
          </span>
        )}
      </div>

      <p className="mt-1 text-xs text-gray-400">
        {current.description}
        {/* 如实告知作用范围：用户最容易误解的就是"改了模式，之前的回答也变了" */}
        {hasActiveChat && '（只影响之后的消息，历史消息不会被重写）'}
      </p>
    </div>
  )
}
