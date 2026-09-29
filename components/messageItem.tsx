// components/messageItem.tsx
import { Message } from '@/types/chat';
import { cn } from '@/lib/utils';
import { CodeBlock } from '@/components/codeBlock';
import { useArtifact } from '@/stores/useArtifact';

interface MessageItemProps {
  message: Message;
  onReload?: () => void;
}

/** 状态徽标文案 */
const STATUS_LABELS: Record<string, string> = {
  streaming: '生成中',
  tool: '工具调用中',
  approval: '等待批准',
  error: '失败',
};

export function MessageItem({ message, onReload }: MessageItemProps) {
  const isUser = message.role === 'user'
  const { showArtifact } = useArtifact()
  const status = message.status ?? 'done'
  const isError = status === 'error'

  // 解析消息内容，提取代码块
  const renderContent = (content: string) => {
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

    while ((match = codeBlockRegex.exec(content)) !== null) {
      if (match.index > lastIndex) {
        // 非代码块部分
        parts.push(
          <span key={`text:${lastIndex}`}>
            {content.slice(lastIndex, match.index)}
          </span>
        )
      }

      pushCode(
        match[2].trim(),
        match[1] || 'text',
        `code-${match.index}`,
        true,
      )

      // 剩余部分文本，match[0]为完整内容
      lastIndex = match.index + match[0].length
    }

    // 处理剩余文本：若其中含未闭合的 ```，把后半段当作「生成中的代码块」
    const rest = content.slice(lastIndex)
    const openFence = rest.indexOf('```')
    if (openFence !== -1) {
      const beforeFence = rest.slice(0, openFence)
      if (beforeFence) {
        parts.push(<span key={`text-tail-${lastIndex}`}>{beforeFence}</span>)
      }
      const fenceLine = rest.slice(openFence + 3)
      const newlineIndex = fenceLine.indexOf('\n')
      // 没换行说明语言标记都还没输出完，先不渲染代码块
      if (newlineIndex !== -1) {
        const language = fenceLine.slice(0, newlineIndex).trim() || 'text'
        const code = fenceLine.slice(newlineIndex + 1)
        pushCode(code, language, `code-open-${lastIndex + openFence}`, false)
      } else {
        parts.push(<span key={`text-fence-${lastIndex}`}>{rest.slice(openFence)}</span>)
      }
    } else if (rest) {
      parts.push(<span key={`text-${lastIndex}`}>{rest}</span>)
    }

    return parts.length > 0 ? parts : content
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
          {!isUser && status === 'error' && onReload && (
            <button type="button" onClick={onReload} className="underline hover:no-underline">
              重试
            </button>
          )}
        </div>

        {/* 消息内容 */}
        <div className="whitespace-pre-wrap break-words">
          {isUser ? message.content : renderContent(message.content)}
        </div>

        {/* 差错详情 */}
        {isError && message.errorText && (
          <div className="mt-2 text-xs text-red-600 break-all">{message.errorText}</div>
        )}

        {/* 工具轨迹（Day 5 接上工具后这里会实时增长） */}
        {!isUser && message.tools && message.tools.length > 0 && (
          <div className="mt-2 space-y-1">
            {message.tools.map((tool) => (
              <div
                key={tool.toolCallId}
                className="text-xs rounded bg-white/60 border border-gray-200 px-2 py-1 text-gray-600"
              >
                <span className="font-medium">{tool.toolName}</span>
                <span className="ml-1 opacity-70">{tool.status}</span>
                {tool.inputText && (
                  <span className="ml-1 font-mono opacity-70 break-all">{tool.inputText}</span>
                )}
                {tool.errorText && <span className="ml-1 text-red-600">{tool.errorText}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}