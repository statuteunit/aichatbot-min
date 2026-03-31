// components/ChatInput.tsx
'use client';

import { FormEvent, KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

interface ChatInputProps {
  input: string;
  isLoading: boolean;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
}

export function ChatInput({ 
  input, 
  isLoading, 
  onInputChange, 
  onSubmit 
}: ChatInputProps) {
  
  // 表单提交
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (input.trim() && !isLoading) {
      onSubmit();
    }
  };

  // 键盘事件（Enter 发送，Shift+Enter 换行）
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (input.trim() && !isLoading) {
        onSubmit();
      }
    }
  };

  return (
    <form onSubmit={handleSubmit} className="p-4 border-t">
      <div className="flex space-x-2">
        <Textarea
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
          disabled={isLoading}
          className="flex-1"
          rows={1}
        />
        <Button 
          type="submit" 
          disabled={!input.trim() || isLoading}
          className="self-end"
        >
          {isLoading ? '发送中...' : '发送'}
        </Button>
      </div>
    </form>
  );
}