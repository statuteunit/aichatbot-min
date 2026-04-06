// components/MessageItem.tsx
import { Message } from '@/types/chat';
import { cn } from '@/lib/utils';
import { CodeBlock } from '../codeBlock';
import { useArtifact, parseArtifactFromContent } from '@/hooks/useArtifact';

interface MessageItemProps {
  message: Message;
}

export function MessageItem({ message }: MessageItemProps) {
  const isUser = message.role === 'user'
  const { showArtifact } = useArtifact()

  // 解析消息内容，提取代码块
  const renderContent = (content: string) => {
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g
    const parts: React.ReactNode[] = []
    let lastIndex = 0
    // 数组-like 对象
    // [
    //   '```javascript\nconsole.log("hello");\n```',  // 索引0: 完整匹配
    //   'javascript',                                 // 索引1: 第1个捕获组
    //   'console.log("hello");',                     // 索引2: 第2个捕获组
    //   index: 7,                                    // 匹配在字符串中的起始位置
    //   input: '# 标题\n```javascript\nconsole.log("hello");\n```', // 原始字符串
    //   groups: undefined                            // 命名捕获组（本例无）
    // ]
    let match

    while ((match = codeBlockRegex.exec(content)) !== null) {
      if (match.index > lastIndex) {
        // 非代码块部分
        parts.push(
          <span key={`text:${lastIndex}`}>
            {content.slice(lastIndex, match.index)}
          </span>
        )

        // 添加代码块
        const language = match[1] || 'text'
        const code = match[2].trim()
        parts.push(
          <CodeBlock
            key={`code-${match.index}`}
            code={code}
            language={language}
            onOpenInArtifact={() => {
              showArtifact({
                id: Date.now().toString(),
                kind: 'code',
                title: `代码片段`,
                content: code,
                language,
                isVisible: true,
              });
            }}
          />
        )

        // 剩余部分文本，match[0]为完整内容
        lastIndex = match.index + match[0].length
      }
    }
    // 添加剩余文本
    if (lastIndex < content.length) {
      parts.push(
        <span key={`text-${lastIndex}`}>
          {content.slice(lastIndex)}
        </span>
      );
    }
    return parts.length > 0 ? parts : content;
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
            : 'bg-gray-100 text-gray-900'
        )}
      >
        {/* 角色标签 */}
        <div className="text-xs opacity-70 mb-1">
          {isUser ? 'you' : 'AI'}
        </div>

        {/* 消息内容 */}
        <div className="whitespace-pre-wrap break-words">
          {isUser ? message.content : renderContent(message.content)}
        </div>
      </div>
    </div>
  );
}