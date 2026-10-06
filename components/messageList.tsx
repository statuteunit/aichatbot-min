// components/messageList.tsx
'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { UIMessage } from 'ai';
import { MessageItem } from '@/components/messageItem';
import type { MessageStatus } from '@/types/stream';

interface MessageListProps {
  messages: UIMessage[]
  /** 当前流式状态；历史加载时不传，视为已完成 */
  status?: MessageStatus
  hasMore?: boolean
  isLoadingOlder?: boolean
  onLoadOlder?: () => void
  /** 出错时的重试入口 */
  onReload?: () => void
  /** 对 needsApproval 的工具做批准/拒绝决定 */
  onApprovalResponse?: (params: { id: string; approved: boolean; reason?: string }) => void
}

/** 工具名 → 展示文案 */
const TOOL_LABELS: Record<string, string> = {
  listDir: '正在浏览目录',
  readFile: '正在读取文件',
  grep: '正在检索代码',
  gitLog: '正在查看提交历史',
  gitDiff: '正在查看改动',
  readSensitiveFile: '正在查看敏感文件结构',
}

export function MessageList({
  messages,
  status = 'done',
  hasMore = false,
  isLoadingOlder = false,
  onLoadOlder,
  onReload,
  onApprovalResponse,
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

  // 正在跑的工具名：取最后一条助手消息里最后一个 tool part。
  // 不用 useMemo —— 依赖是 messages，每次流式增量都会变，记忆化没有收益。
  const runningToolName = (() => {
    if (status !== 'tool') return undefined
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i]
      if (message.role !== 'assistant') continue
      const toolParts = message.parts.filter(
        (part) => part.type.startsWith('tool-') || part.type === 'dynamic-tool',
      )
      const last = toolParts[toolParts.length - 1]
      if (!last) return undefined
      if (last.type === 'dynamic-tool') {
        return (last as { toolName?: string }).toolName
      }
      return last.type.slice('tool-'.length)
    }
    return undefined
  })()

  // 是否已有助手消息在承载流式内容：
  // 有的话就不显示独立的"生成中"气泡，避免出现两个加载指示
  const tailIsAssistantStreaming =
    (status === 'streaming' || status === 'tool') &&
    messages.length > 0 &&
    messages[messages.length - 1].role === 'assistant'

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
      {messages.map((message, index) => (
        <MessageItem
          key={message.id}
          message={message}
          // 只有最后一条消息才呈现当前流式状态，历史消息一律 done
          status={index === messages.length - 1 ? status : 'done'}
          onReload={onReload}
          onApprovalResponse={onApprovalResponse}
        />
      ))}

      {/* 尚未出现助手消息时的等待指示 */}
      {status === 'streaming' && !tailIsAssistantStreaming && (
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

      {/* 工具运行状态：product-spec §11 要求「工具调用过程实时可见」 */}
      {status === 'tool' && (
        <div className="flex justify-start">
          <div className="bg-amber-50 text-amber-800 border border-amber-200 rounded-lg px-4 py-2 text-sm">
            {runningToolName
              ? `${TOOL_LABELS[runningToolName] ?? `正在调用 ${runningToolName}`}…`
              : '正在调用工具…'}
          </div>
        </div>
      )}

      {status === 'approval' && (
        <div className="flex justify-start">
          {/* 审批的详细内容（工具名、参数、批准/拒绝按钮）由消息内的
              ApprovalCard 承载，这里只放一个位置提示，避免两处重复。 */}
          <div className="text-xs text-violet-700 px-1">
            等待你就上方的操作做出决定
          </div>
        </div>
      )}

      {status === 'error' && (
        <div className="flex justify-start">
          <div className="bg-red-50 text-red-700 border border-red-200 rounded-lg px-4 py-2 text-sm flex items-center gap-3">
            <span className="break-all">生成失败，请重试</span>
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
