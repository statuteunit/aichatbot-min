'use client'

import { useState } from 'react';
import { useArtifact } from '@/stores/useArtifact';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export function ArtifactPanel() {
  const { artifact, hideArtifact, updateContent } = useArtifact();
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState('');

  // 富文本内容为空或不可见
  if (!artifact || !artifact.isVisible) {
    return null
  }

  // 进入编辑内容
  const handleEdit = () => {
    setEditContent(artifact.content)
    setIsEditing(true)
  }

  // 保存
  const handleSave = () => {
    updateContent(editContent)
    setIsEditing(false)
  }

  // 取消编辑
  const handleCancel = () => {
    setIsEditing(false)
  }

  // 用户复制内容
  const handleCopy = () => {
    navigator.clipboard.writeText(artifact.content);
  };

  return (
    <div className="fixed right-0 top-0 h-full w-[500px] bg-white border-l shadow-lg z-50 flex flex-col">
      {/* 头部 */}
      <div className="p-4 border-b flex items-center justify-between">
        <div>
          <h3 className="font-bold">{artifact.title}</h3>
          {artifact.kind === 'code' && artifact.language && (
            <span className="text-xs text-gray-500">{artifact.language}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!isEditing && (
            <>
              <Button size="sm" variant="ghost" onClick={handleCopy}>
                复制
              </Button>
              <Button size="sm" variant="ghost" onClick={handleEdit}>
                编辑
              </Button>
            </>
          )}
          <button
            onClick={hideArtifact}
            className="text-gray-500 hover:text-gray-700"
          >
            ✕
          </button>
        </div>
      </div>

      {/* 内容区域 */}
      <div className="flex-1 overflow-auto p-4">
        {isEditing ? (
          <div className="h-full flex flex-col">
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="flex-1 w-full p-4 border rounded font-mono text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="flex justify-end gap-2 mt-4">
              <Button size="sm" variant="outline" onClick={handleCancel}>
                取消
              </Button>
              <Button size="sm" onClick={handleSave}>
                保存
              </Button>
            </div>
          </div>
        ) : (
          // readFileTool 返回的内容每行已带 `行号: ` 前缀，这里据此高亮目标区间。
          // 高亮的意义：点击 file:line 之后要能**一眼看到** AI 引用的那几行，
          // 否则打开 500 行文件等于没定位。
          <div className="font-mono text-sm bg-gray-50 p-4 rounded">
            {artifact.content.split('\n').map((line, index) => {
              const lineNo = Number.parseInt(line, 10)
              const inRange =
                artifact.startLine !== undefined &&
                artifact.endLine !== undefined &&
                Number.isInteger(lineNo) &&
                lineNo >= artifact.startLine &&
                lineNo <= artifact.endLine
              return (
                <div
                  key={index}
                  className={cn(
                    'whitespace-pre-wrap break-words',
                    inRange && 'bg-amber-100 -mx-2 px-2',
                  )}
                >
                  {line}
                </div>
              )
            })}
            {artifact.endLine !== undefined && (
              <p className="mt-3 pt-3 border-t text-xs text-gray-500 font-sans not-italic">
                已定位到第 {artifact.startLine}
                {artifact.endLine !== artifact.startLine ? `–${artifact.endLine}` : ''} 行
                （黄色标记处）
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}