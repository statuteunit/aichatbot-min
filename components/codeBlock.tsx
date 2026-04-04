'use client';

import { useState } from 'react';
import { Button } from './ui/button';

interface CodeBlockProps {
  code: string;
  language?: string;
  onOpenInArtifact?: () => void;
}

export function CodeBlock({ code, language, onOpenInArtifact }: CodeBlockProps) {
  const [isCopied, setIsCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  }

  return (
    <div className="my-4 rounded-lg border border-gray-200 overflow-hidden">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-100 border-b">
        <span className="text-xs text-gray-500 font-medium">
          {language || 'code'}
        </span>
        <div className="flex items-center gap-2">
          {onOpenInArtifact && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onOpenInArtifact}
              className="text-xs h-6 px-2"
            >
              在面板中打开
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={handleCopy}
            className="text-xs h-6 px-2"
          >
            {isCopied ? '已复制!' : '复制'}
          </Button>
        </div>
      </div>

      {/* 代码内容 */}
      <pre className="p-4 overflow-x-auto bg-gray-50 text-sm">
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  )
}