'use client'

import { useState } from 'react';
import { useArtifact } from '@/hooks/useArtifact';
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
          <pre className="font-mono text-sm whitespace-pre-wrap break-words bg-gray-50 p-4 rounded">
            {artifact.content}
          </pre>
        )}
      </div>
    </div>
  )
}