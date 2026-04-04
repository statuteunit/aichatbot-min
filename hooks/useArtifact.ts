'use client'

import { Artifact, ArtifactState } from "@/types/artifact";
import { create } from 'zustand'
import { generateId } from "@/lib/utils";

// 使用Zustand简化状态管理
export const useArtifact = create<ArtifactState>((set) => ({
  artifact: null,
  setArtifact: (artifact) => set({ artifact }),

  showArtifact: (artifact) => set({
    artifact: { ...artifact, isVisible: true }
  }),

  hideArtifact: () => set((state) => ({
    artifact: state.artifact
      ? { ...state.artifact, isVisible: false }
      : null
  })),

  updateContent: (content) => set((state) => ({
    artifact: state.artifact
      ? { ...state.artifact, content }
      : null
  })),
}))

// 从消息内容解析 Artifact
export function parseArtifactFromContent(content: string): Artifact | null {
  // 匹配代码块 ```language\ncode\n```
  // 匹配 Markdown 格式的代码块\
  // 匹配```开头```结尾
  // (\w+)匹配代码使用的语言，一个或多个单词字符，可选
  // \s\S匹配任意字符，\s匹配空格换行制表符，\S匹配非空字符*?非贪婪匹配尽可能少的匹配，捕获代码块内容
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/
  // 匹配结果为一个数组，第一个为```，第二个为匹配的语言或undefined
  // 第三个为代码内容，第四个为```结束
  const match = content.match(codeBlockRegex)

  if (match) {
    const language = match[1] || 'text'
    const code = match[2] || ''

    return {
      id: generateId(),
      kind: 'code',
      title: '代码块',
      content: code,
      language,
      isVisible: false
    }
  }
  return null
}