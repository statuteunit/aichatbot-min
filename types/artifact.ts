export type ArtifactKind = 'code' | 'text'

export interface Artifact {
  id: string
  kind: ArtifactKind//富文本类型
  title: string
  content: string//富文本内容
  language: string//代码使用的语言
  isVisible: boolean//是否可见
}

export interface ArtifactState {
  artifact: Artifact | null
  setArtifact: (artifact: Artifact | null) => void//设置当前选中的富文本
  showArtifact: (artifact: Artifact) => void//是否显示富文本详情弹窗
  hideArtifact: () => void//是否隐藏富文本详情弹窗
  updateContent: (content: string) => void//更新当前选中的富文本内容
}