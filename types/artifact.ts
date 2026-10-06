export type ArtifactKind = 'code' | 'text'

export interface Artifact {
  id: string
  kind: ArtifactKind//富文本类型
  title: string
  content: string//富文本内容
  language: string//代码使用的语言
  isVisible: boolean//是否可见
  /**
   * 打开的是仓库文件时的显示行号区间（1-based，含两端）。
   * 由「点击 file:line」产生；代码块 Artifact 不带这两个字段。
   * 面板据此高亮该区间，让"点进去"能直接看到 AI 引用的那几行。
   */
  startLine?: number
  endLine?: number
}

export interface ArtifactState {
  artifact: Artifact | null
  setArtifact: (artifact: Artifact | null) => void//设置当前选中的富文本
  showArtifact: (artifact: Artifact) => void//是否显示富文本详情弹窗
  hideArtifact: () => void//是否隐藏富文本详情弹窗
  updateContent: (content: string) => void//更新当前选中的富文本内容
}