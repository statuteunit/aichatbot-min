// components/messageItem.tsx
//
// 从自定义 Message 迁到 AI SDK 的 UIMessage：
// 内容来自 message.parts 的 text part，工具过程来自 tool-* part。
import type { UIMessage } from 'ai';
import { cn } from '@/lib/utils';
import { CodeBlock } from '@/components/codeBlock';
import { ApprovalCard, type ApprovalState } from '@/components/approvalCard';
import { renderWithFileRefs } from '@/components/fileLink';
import { useArtifact } from '@/stores/useArtifact';
import { uiMessageToText } from '@/lib/chat/mappers';
import type { MessageStatus } from '@/types/stream';

interface MessageItemProps {
  message: UIMessage;
  /** 六态展示状态；历史消息不传，默认视为已完成 */
  status?: MessageStatus;
  onReload?: () => void;
  /** 对 needsApproval 的工具做批准/拒绝决定 */
  onApprovalResponse?: (params: { id: string; approved: boolean; reason?: string }) => void;
}

/** 状态徽标文案 */
const STATUS_LABELS: Record<string, string> = {
  streaming: '生成中',
  tool: '工具调用中',
  approval: '等待批准',
  error: '失败',
};

/** 工具名 → 展示文案 */
const TOOL_LABELS: Record<string, string> = {
  listDir: '浏览目录',
  readFile: '读取文件',
  grep: '检索代码',
  gitLog: '查看提交历史',
  gitDiff: '查看改动',
  readSensitiveFile: '查看敏感文件结构',
};

/** ToolUIPart.state → 中文短标 */
const TOOL_STATE_LABELS: Record<string, string> = {
  'input-streaming': '参数生成中',
  'input-available': '执行中',
  'approval-requested': '等待批准',
  'approval-responded': '已审批',
  'output-available': '完成',
  'output-error': '失败',
  'output-denied': '已拒绝',
};

/** 需要渲染审批卡片的 state */
const APPROVAL_STATES: ReadonlySet<string> = new Set([
  'approval-requested',
  'approval-responded',
  'output-denied',
]);

/** 从 tool part 的 type 里取出工具名：'tool-listDir' → 'listDir' */
function toolNameOf(partType: string): string {
  return partType.startsWith('tool-') ? partType.slice('tool-'.length) : partType;
}

export function MessageItem({ message, status = 'done', onReload, onApprovalResponse }: MessageItemProps) {
  const isUser = message.role === 'user'
  const { showArtifact } = useArtifact()
  const isError = status === 'error'

  // 内容来自 parts：只取 text part（推理与工具过程单独展示）。
  // 必须 trim：多步工具调用时，模型常产出只有换行的 text part
  // （例如"**"与后续内容被拆到两个 part），原样渲染会撑出一块空白。
  const content = uiMessageToText(message).replace(/^\n+|\n+$/g, '')

  // 工具轨迹：动态工具（MCP 等）的 type 是 'dynamic-tool'，一并纳入
  const toolParts = message.parts.filter(
    (part) => part.type.startsWith('tool-') || part.type === 'dynamic-tool',
  )

  // 解析消息内容，提取代码块
  const renderContent = (text: string) => {
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g
    const parts: React.ReactNode[] = []
    let lastIndex = 0
    let match

    const pushCode = (code: string, language: string, key: string, closed: boolean) => {
      parts.push(
        <CodeBlock
          key={key}
          code={code}
          language={language}
          onOpenInArtifact={() => {
            showArtifact({
              id: Date.now().toString(),
              kind: 'code',
              title: closed ? `代码片段` : `代码片段（生成中）`,
              content: code,
              language,
              isVisible: true,
            });
          }}
        />
      )
    }

    while ((match = codeBlockRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        // 代码块**之外**的文本才做 file:line 链接化 ——
        // 代码里的字符串常量（如 'src/a.ts:1'）不该变成链接
        parts.push(...renderWithFileRefs(text.slice(lastIndex, match.index), `pre-${lastIndex}`))
      }

      pushCode(match[2].trim(), match[1] || 'text', `code-${match.index}`, true)

      // 剩余部分文本，match[0]为完整内容
      lastIndex = match.index + match[0].length
    }

    // 处理剩余文本：若其中含未闭合的 ```，把后半段当作「生成中的代码块」
    const rest = text.slice(lastIndex)
    const openFence = rest.indexOf('```')
    if (openFence !== -1) {
      const beforeFence = rest.slice(0, openFence)
      if (beforeFence) {
        parts.push(...renderWithFileRefs(beforeFence, `tail-${lastIndex}`))
      }
      const fenceLine = rest.slice(openFence + 3)
      const newlineIndex = fenceLine.indexOf('\n')
      if (newlineIndex !== -1) {
        const language = fenceLine.slice(0, newlineIndex).trim() || 'text'
        const code = fenceLine.slice(newlineIndex + 1)
        pushCode(code, language, `code-open-${lastIndex + openFence}`, false)
      } else {
        parts.push(<span key={`text-fence-${lastIndex}`}>{rest.slice(openFence)}</span>)
      }
    } else if (rest) {
      parts.push(...renderWithFileRefs(rest, `rest-${lastIndex}`))
    }

    return parts.length > 0 ? parts : text
  }

  // 整条消息什么都没有（只有 step-start、没有文本也没有工具）→ 不渲染。
  // 这不是理论情况：多步工具调用会产生这种"空 assistant 消息"，
  // 每个都渲染一遍会在气泡上方堆出可观的空白。
  if (!content && toolParts.length === 0) {
    return null
  }

  return (
    <div
      className={cn(
        'flex w-full',
        isUser ? 'justify-end' : 'justify-start'
      )}
    >
      <div
        className={cn(
          'max-w-[80%] rounded-lg px-4 py-2',
          isUser
            ? 'bg-blue-600 text-white'
            : isError
              ? 'bg-red-50 text-red-900 border border-red-200'
              : 'bg-gray-100 text-gray-900'
        )}
      >
        {/* 角色标签 + 状态徽标 */}
        <div className="text-xs opacity-70 mb-1 flex items-center gap-2">
          <span>{isUser ? 'you' : 'AI'}</span>
          {!isUser && STATUS_LABELS[status] && (
            <span
              className={cn(
                'rounded px-1.5 py-0.5',
                isError ? 'bg-red-200 text-red-800' : 'bg-gray-200 text-gray-700',
              )}
            >
              {STATUS_LABELS[status]}
            </span>
          )}
          {!isUser && isError && onReload && (
            <button type="button" onClick={onReload} className="underline hover:no-underline">
              重试
            </button>
          )}
        </div>

        {/* 消息内容。
            注意：whitespace-pre-wrap 必须加在**每个文本片段**上，不能加在这个容器上。
            因为容器里混着块级元素（CodeBlock 的 div）—— 在带 pre-wrap 的容器里，
            文本会被包进匿名行盒、块级子元素又打断行盒，浏览器会算出多余高度，
            表现为气泡上方出现一块莫明其妙的空白。
            另有：content 为空时不渲染这个 div，避免空消息占位。 */}
        {(isUser || content) && (
          <div className="break-words">
            {isUser ? (
              <span className="whitespace-pre-wrap">{content}</span>
            ) : (
              renderContent(content)
            )}
          </div>
        )}

        {/* 工具轨迹：只展示工具名与状态，不暴露参数与原始输出
            （参数里可能有路径、输出里可能有代码片段，都不该无差别铺到界面上）。
            例外：需要审批的工具会把参数展示在审批卡片里——审批的意义就是
            让人看到"模型想干什么"，隐藏参数等于让用户盲签。 */}
        {!isUser && toolParts.length > 0 && (
          <div className="mt-2 space-y-1">
            {toolParts.map((part, index) => {
              const name =
                part.type === 'dynamic-tool'
                  ? ((part as { toolName?: string }).toolName ?? 'tool')
                  : toolNameOf(part.type);
              const state = (part as { state?: string }).state ?? '';
              const approval = (part as {
                approval?: { id?: string; approved?: boolean; reason?: string };
                input?: unknown;
              }).approval;
              const toolLabel = TOOL_LABELS[name] ?? name;

              // 审批相关的 part 渲染成卡片（含拒绝后的只读回执）
              if (approval?.id && APPROVAL_STATES.has(state)) {
                return (
                  <ApprovalCard
                    key={`${message.id}-approval-${index}`}
                    toolLabel={toolLabel}
                    input={(part as { input?: unknown }).input}
                    state={state as ApprovalState}
                    approved={approval.approved}
                    reason={approval.reason}
                    onRespond={
                      state === 'approval-requested' && onApprovalResponse
                        ? (approved, reason) =>
                            onApprovalResponse({ id: approval.id as string, approved, reason })
                        : undefined
                    }
                  />
                );
              }

              return (
                <div
                  key={`${message.id}-tool-${index}`}
                  className="text-xs rounded bg-white/60 border border-gray-200 px-2 py-1 text-gray-600"
                >
                  <span className="font-medium">{toolLabel}</span>
                  {state && (
                    <span className="ml-1 opacity-70">
                      {TOOL_STATE_LABELS[state] ?? state}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
