// components/MessageList.tsx
'use client';

import { useEffect, useRef } from 'react';
import { Message } from '@/types/chat';
import { MessageItem } from '@/components/ui/messageItem';

interface MessageListProps {
  messages: Message[];
  isLoading: boolean;
}

export function MessageList({ messages, isLoading }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // 自动滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {/* 空状态 */}
      {messages.length === 0 && (
        <div className="flex items-center justify-center h-full text-gray-400">
          开始一段对话吧！
        </div>
      )}

      {/* 消息列表 */}
      {messages.map((message) => (
        <MessageItem key={message.id} message={message} />
      ))}

      {/* 加载状态 */}
      {isLoading && (
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

      {/* 滚动锚点 */}
      <div ref={bottomRef} />
    </div>
  );
}