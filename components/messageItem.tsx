// components/messageItem.tsx
//
// 从自定义 Message 迁到 AI SDK 的 UIMessage：
// 内容来自 message.parts 的 text part，工具过程来自 tool-* part。
import type { UIMessage } from 'ai';
import { cn } from '@/lib/utils';
import { CodeBlock } from '@/components/codeBlock';
import { ApprovalCard, type ApprovalState } from '@/components/approvalCard';
import { RevertProposalButton } from '@/components/revertProposalButton';
import { renderWithFileRefs } from '@/components/fileLink';
import { useArtifact } from '@/stores/useArtifact';
import { uiMessageToText } from '@/lib/chat/mappers';
import type { MessageStatus } from '@/types/stream';
import type { ApprovalResponse } from '@/types/stream';

interface MessageItemProps {
  message: UIMessage;
  /** 六态展示状态；历史消息不传，默认视为已完成 */
  status?: MessageStatus;
  onReload?: () => void;
  /** 对 needsApproval 的工具做批准/拒绝决定 */
  onApprovalResponse?: (params: ApprovalResponse) => void;
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
  // 下面三个是写盘类工具。必须显式给中文名：
  // 缺了就会走 `TOOL_LABELS[name] ?? name` 的兜底，把函数名原样铺到界面上。
  createPatchProposal: '生成修改提案',
  applyApprovedPatch: '应用已批准的修改',
  runApprovedValidation: '运行验证任务',
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

/** 从工具 part 的返回值里取 previewUrl（只有 createPatchProposal 成功时才有）。 */
function previewUrlOf(part: unknown): string | null {
  const output = (part as { output?: unknown }).output
  if (!output || typeof output !== 'object') return null
  const candidate = (output as { previewUrl?: unknown }).previewUrl
  return typeof candidate === 'string' && candidate.startsWith('/agent/proposals/')
    ? candidate
    : null
}

/** 从工具 part 的入参里取 proposalId（applyApprovedPatch 的回滚入口要用）。 */
function proposalIdOf(part: unknown): string | null {
  const input = (part as { input?: unknown }).input
  if (!input || typeof input !== 'object') return null
  const candidate = (input as { proposalId?: unknown }).proposalId
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null
}

/** 工具返回值里显式声明了 ok:false 时，返回**错误名称**（code）；否则返回 null。
 *
 * 为什么不能只看 state：'output-available' 只表示**工具执行完了**，
 * 不表示工具**成功**了 —— 工具返回 { ok:false, code, message } 时 state 依然是
 * 'output-available'，界面会照 TOOL_STATE_LABELS 显示成"完成"。
 * 于是"提案一个都没生成"这件事在界面上看起来像"成功了 5 次"。
 *
 * 为什么只取 code、**丢掉 message**：message 是实现细节，是给日志和服务端看的
 * （"hunk 行数不符：声明 -7/+7…"、"提案必须归属一次分析（AgentRun）…"）。
 * 界面上只该回答"失败了、失败的名字是什么"，不该把内部函数的抱怨原样铺给用户。
 * 完整 message 仍然在日志里：agent.toolCall 的 outputPreview 字段。
 *
 * 为什么只认 ok:false 而不是猜别的字段：lib/agent/security.ts 的 toToolErrorResult
 * 与 lib/agent/tools/index.ts 的 guardTool 拦截分支都返回同形的
 * `{ ok: false, code, message }`，所以这一个判定覆盖了全部工具的失败路径。 */
function toolErrorNameOf(part: unknown): string | null {
  const output = (part as { output?: unknown }).output
  if (!output || typeof output !== 'object') return null

  const candidate = output as { ok?: unknown; code?: unknown; data?: unknown }
  // 兜底：万一将来 guardTool 把返回值包了一层，失败信息在 data 里
  const inner =
    candidate.data && typeof candidate.data === 'object' && 'ok' in (candidate.data as object)
      ? (candidate.data as { ok?: unknown; code?: unknown })
      : candidate

  if (inner.ok !== false) return null
  return typeof inner.code === 'string' && inner.code ? inner.code : 'UNKNOWN'
}

/** 一条 tool part 的工具名（动态工具的 type 是 'dynamic-tool'，名字挂在 toolName 上）。 */
function partToolName(part: unknown): string {
  const type = (part as { type?: string }).type ?? ''
  if (type === 'dynamic-tool') return (part as { toolName?: string }).toolName ?? 'tool'
  return toolNameOf(type)
}

/**
 * 这份消息里**成功应用**的提案 id（按出现顺序、去重）。
 *
 * 为什么判定用 state + errorName，而不是只认 output.ok：
 *   - 实时：工具成功时 state 是 output-available；但失败时 state **同样**是
 *     output-available（只是 output.ok === false），所以必须再叠一层 toolErrorNameOf。
 *   - 历史回放（lib/chat/mappers.ts:45-59）：ToolCallRecord.status 已经把成败分开
 *     落库了（ok → output-available、error → output-error），而 output 列存的是
 *     摘要**字符串**而不是对象。所以 state 在两条路径上都是可靠信号，
 *     errorName 只是补上实时路径那个缺口。
 *
 * 为什么是数组：一条消息可以连续应用多份提案（日志里就有连续三次 apply 的记录），
 * 每份都要有自己的回滚按钮，否则用户只能回滚其中一部分。
 */
function appliedProposalIdsOf(parts: ReadonlyArray<unknown>): string[] {
  const ids: string[] = []
  for (const part of parts) {
    if (partToolName(part) !== 'applyApprovedPatch') continue
    if ((part as { state?: string }).state !== 'output-available') continue
    if (toolErrorNameOf(part) !== null) continue
    const id = proposalIdOf(part)
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
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

  // 已成功应用的提案 —— 消息级回滚入口的数据来源（渲染见气泡末尾）
  const appliedProposalIds = isUser ? [] : appliedProposalIdsOf(toolParts)

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
                    toolName={name}
                    input={(part as { input?: unknown }).input}
                    state={state as ApprovalState}
                    approved={approval.approved}
                    reason={approval.reason}
                    onRespond={
                      state === 'approval-requested' && onApprovalResponse
                        ? (approved, reason) =>
                          onApprovalResponse({
                            id: approval.id as string,
                            approved,
                            reason,
                            // 工具名与入参必须一起带上：
                            // 只传 approvalId 的话，上层无法知道"这次批准要不要
                            // 先把这个 proposal 落库成 approved"。
                            toolName: name,
                            input: (part as { input?: unknown }).input,
                          })
                        : undefined
                    }
                  />
                );
              }

              const previewUrl = previewUrlOf(part)
              // 工具"执行完了"不等于"成功了"：ok:false 也是 output-available
              const errorName = toolErrorNameOf(part)
              const failed = errorName !== null || state === 'output-error'
              const stateLabel = failed ? '失败' : TOOL_STATE_LABELS[state] ?? state

              return (
                <div
                  key={`${message.id}-tool-${index}`}
                  className={cn(
                    'text-xs rounded border px-2 py-1',
                    failed
                      ? 'border-red-300 bg-red-50 text-red-700'
                      : 'border-gray-200 bg-white/60 text-gray-600',
                  )}
                >
                  <span className="font-medium">{toolLabel}</span>
                  {state && (
                    <span className={cn('ml-1', failed ? 'font-medium' : 'opacity-70')}>
                      {stateLabel}
                    </span>
                  )}
                  {/* 只展示错误名称，不展示 message：
                      message 是给日志的实现细节（"hunk 行数不符…"、
                      "提案必须归属一次分析（AgentRun）…"），
                      铺到界面上既吓人又没有可操作性。 */}
                  {errorName ? (
                    <code className="ml-1 rounded bg-red-100 px-1 font-mono text-[10px]">
                      {errorName}
                    </code>
                  ) : null}
                  {/* 提案的入口不能只挂在 apply 的审批卡片上：
                      模型没走到 apply（或 apply 被拒）时，提案就完全没有入口。 */}
                  {previewUrl ? (
                    <a
                      href={previewUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-2 font-medium text-blue-600 underline hover:text-blue-700"
                    >
                      打开提案页（Diff · 文件树）
                    </a>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        {/* 提案应用成功后的回滚入口 —— 这条消息本身的一部分，而不是缩在工具条里。
            为什么放在消息层级：「应用成功」的后果落在磁盘上（工作区文件真的被改写了），
            回滚是这一整轮对话的重做开关，应该与消息同级可见；
            缩进工具条里既不显眼，也体现不出"这条消息改过什么"。
            只在**确实应用成功**时出现：待批准、被拒绝、校验失败都没有可回滚的东西。 */}
        {!isUser && appliedProposalIds.length > 0 && (
          <div className="mt-2 space-y-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5">
            <p className="text-xs font-medium text-amber-900">
              已应用 {appliedProposalIds.length} 份提案，工作区文件已被改写
            </p>
            {appliedProposalIds.map((proposalId) => (
              <RevertProposalButton key={proposalId} proposalId={proposalId} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
