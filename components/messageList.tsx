// components/messageList.tsx
'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Message } from '@/types/chat';
import { MessageItem } from '@/components/messageItem';

interface MessageListProps {
  messages: Message[]
  hasMore?: boolean
  isLoadingOlder?: boolean
  onLoadOlder?: () => void
  /** 出错时的重试入口 */
  onReload?: () => void
}

/** 工具名 → 展示文案（Day 5 接上真实工具后在此扩展） */
const TOOL_LABELS: Record<string, string> = {
  listDir: '正在浏览目录',
  readFile: '正在读取文件',
  grep: '正在检索代码',
  getGitDiff: '正在查看改动',
}

export function MessageList({
  messages,
  hasMore = false,
  isLoadingOlder = false,
  onLoadOlder,
  onReload,
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null)

  // 自动滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el || !onLoadOlder || isLoadingOlder || !hasMore) return

    if (el.scrollTop <= 80) {
      onLoadOlder()
    }
  }, [onLoadOlder, isLoadingOlder, hasMore])

  // 最后一条 assistant 消息承载当前流状态
  const tail = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'assistant') return messages[i]
    }
    return undefined
  }, [messages])

  const status = tail?.status ?? 'done'
  const lastTool = tail?.tools?.[tail.tools.length - 1]

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto p-4 space-y-4">
      {/* 空状态 */}
      {messages.length === 0 && (
        <div className="flex items-center justify-center h-full text-gray-400">
          开始一段对话吧！
        </div>
      )}

      {/* 消息列表 */}
      {messages.map((message) => (
        <MessageItem key={message.id} message={message} onReload={onReload} />
      ))}

      {/* 流式 / 工具 / 审批 / 错误 状态条 */}
      {status === 'streaming' && (
        <div className="flex justify-start">
          <div className="bg-gray-100 rounded-lg px-4 py-2">
            <div className="flex space-x-1">
              <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" />
              <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-100" />
              <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-200" />
            </div>
          </div>
        </div>
      )}

      {status === 'tool' && (
        <div className="flex justify-start">
          <div className="bg-amber-50 text-amber-800 border border-amber-200 rounded-lg px-4 py-2 text-sm">
            {lastTool ? `${TOOL_LABELS[lastTool.toolName] ?? `正在调用 ${lastTool.toolName}`}…` : '正在调用工具…'}
          </div>
        </div>
      )}

      {status === 'approval' && (
        <div className="flex justify-start">
          <div className="bg-violet-50 text-violet-800 border border-violet-200 rounded-lg px-4 py-2 text-sm">
            等待你批准操作（审批交互将在后续阶段接入）
          </div>
        </div>
      )}

      {status === 'error' && (
        <div className="flex justify-start">
          <div className="bg-red-50 text-red-700 border border-red-200 rounded-lg px-4 py-2 text-sm flex items-center gap-3">
            <span className="break-all">{tail?.errorText ?? '生成失败'}</span>
            {onReload && (
              <button
                type="button"
                onClick={onReload}
                className="shrink-0 underline hover:no-underline"
              >
                重试
              </button>
            )}
          </div>
        </div>
      )}

      {/* 滚动锚点 */}
      <div ref={bottomRef} />
    </div>
  );
}