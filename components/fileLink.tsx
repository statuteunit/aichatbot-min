'use client'

// components/fileLink.tsx
//
// 把 AI 输出里的 `hooks/useChat.ts:120` 渲染成可点击元素：
// 点击后拉取该文件的行区间，在右侧 Artifact 面板打开并高亮。
//
// 最小版的取舍：
//   ① 不做文件树跳转、不做行内 diff、不做编辑保存 —— 只是"看到 AI 引用的那几行"。
//   ② 失败态就地标记而不是弹窗：敏感文件（.env）会 403，这是**预期行为**，
//      弹窗会让人以为出故障了。失败的引用标成划线样式并禁用，避免重复点击。
//   ③ 懒加载：只在点击时请求，不在渲染时预取。一条消息里可能有十几个引用，
//      预取会打出十几个请求。
import { useCallback, useState } from 'react'
import { cn } from '@/lib/utils'
import { useArtifact } from '@/stores/useArtifact'
import { generateId } from '@/lib/utils'

/**
 * 匹配 `路径:行号` 或 `路径:起-止`。
 *
 * 设计取舍（写清楚，否则以后有人"优化"正则就会引入误匹配）：
 *   - 必须带已知扩展名 → 避免把 `12:30`（时间）、`useChat:12`（非路径）当成引用
 *   - 只允许 ASCII 路径字符 + `[` `]` → **方括号是必需的**：
 *     本项目的 Next.js 动态路由路径形如 `app/api/chats/[id]/route.ts`，
 *     不含方括号就会漏掉最常见的一类引用
 *   - 文件名部分用 `[^\s:/\\]+` 而不是 `.+?` → 防止 `见 hooks/useChat.ts:120` 里
 *     把「见」也吃进路径
 *   - 行号后加 (?![0-9]) → 避免在 `a.ts:12` 里匹配出 `a.ts:1`
 *   - 不加 `g` 标志（导出常量本身）：调用方各自用带 g 的副本，
 *     否则 lastIndex 状态会在多次调用之间泄漏
 */
export const FILE_REF_PATTERN =
  /([A-Za-z0-9_@.\-[\]]+(?:[/\\][A-Za-z0-9_@.\-[\]]+)*\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?(?![0-9])/

/** 扩展名 → 代码块语言标记 */
const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
  json: 'json', prisma: 'prisma', sql: 'sql', md: 'markdown',
  css: 'css', html: 'html', yml: 'yaml', yaml: 'yaml',
}

function languageOf(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  return EXT_TO_LANGUAGE[ext] ?? 'text'
}

interface FileRefProps {
  filePath: string
  startLine: number
  endLine?: number
}

export function FileRef({ filePath, startLine, endLine }: FileRefProps) {
  const { showArtifact } = useArtifact()
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  /** 歧义时的候选路径。非空表示"文件存在但模型没写全路径" */
  const [candidates, setCandidates] = useState<string[]>([])

  const label = endLine && endLine !== startLine
    ? `${filePath}:${startLine}-${endLine}`
    : `${filePath}:${startLine}`

  const openFile = useCallback(async (targetPath: string) => {
    const params = new URLSearchParams({
      path: targetPath,
      startLine: String(startLine),
      ...(endLine ? { endLine: String(endLine) } : {}),
    })
    const res = await fetch(`/api/agent/file?${params.toString()}`)
    if (!res.ok) return null
    return res.json() as Promise<{
      path: string
      content: string
      startLine: number
      endLine: number
    }>
  }, [startLine, endLine])

  const handleClick = useCallback(async () => {
    if (loading || failed) return
    setLoading(true)
    try {
      const params = new URLSearchParams({
        path: filePath,
        startLine: String(startLine),
        ...(endLine ? { endLine: String(endLine) } : {}),
      })
      const res = await fetch(`/api/agent/file?${params.toString()}`)

      // 409：仓库里有多个同名文件。这不是"打不开"，而是"需要用户指定哪一个"。
      // 把候选列出来让用户自己选，比标记成死链有用得多。
      if (res.status === 409) {
        const body = await res.json() as { candidates?: string[] }
        setCandidates(Array.isArray(body.candidates) ? body.candidates : [])
        return
      }

      // 403（敏感文件/越界）、404（确实不存在）是**预期**结果，就地标记即可
      if (!res.ok) {
        setFailed(true)
        return
      }

      const data = await res.json()
      showArtifact({
        id: generateId(),
        kind: 'code',
        title: data.path,
        content: data.content,
        language: languageOf(data.path ?? filePath),
        isVisible: true,
        startLine: data.startLine,
        endLine: data.endLine,
      })
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [filePath, startLine, endLine, loading, failed, showArtifact])

  // 歧义态：列出候选让用户自己选。
  // 不加这个分支的话，模型少写一段路径就会让引用变成死链——
  // 用户只看到划掉的灰字，不知道该怎么办。
  if (candidates.length > 0) {
    return (
      <span className="inline-flex flex-col gap-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs align-middle">
        <span className="text-amber-800">
          <code className="font-mono">{filePath}</code> 有 {candidates.length} 个同名文件，选一个：
        </span>
        <span className="flex flex-wrap gap-1">
          {candidates.map((candidate) => (
            <button
              key={candidate}
              type="button"
              onClick={async () => {
                setLoading(true)
                const data = await openFile(candidate)
                setLoading(false)
                if (!data) {
                  setFailed(true)
                  setCandidates([])
                  return
                }
                setCandidates([])
                showArtifact({
                  id: generateId(),
                  kind: 'code',
                  title: data.path,
                  content: data.content,
                  language: languageOf(data.path),
                  isVisible: true,
                  startLine: data.startLine,
                  endLine: data.endLine,
                })
              }}
              className="rounded bg-white border border-amber-300 px-1.5 py-0.5 font-mono text-amber-900 hover:bg-amber-100"
            >
              {candidate}
            </button>
          ))}
        </span>
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading || failed}
      title={
        failed
          ? '无法打开该文件（不存在，或属于敏感文件）'
          : `打开 ${filePath} 的第 ${startLine} 行`
      }
      className={cn(
        'inline rounded px-1 font-mono text-[0.9em] underline decoration-dotted underline-offset-2',
        failed
          ? 'cursor-not-allowed text-gray-400 line-through'
          : 'text-blue-700 hover:bg-blue-50 hover:decoration-solid',
        loading && 'opacity-60',
      )}
    >
      {label}
    </button>
  )
}

/**
 * 把一段纯文本切成「文本 / 文件引用」片段。
 *
 * ⚠️ 调用方必须先按 Markdown 代码块切分，**不要对代码块内部调用本函数**——
 * 代码里的字符串常量（如 `'src/a.ts:1'`）不应该变成链接。
 */
export function renderWithFileRefs(text: string, keyPrefix: string): React.ReactNode[] {
  // split 带捕获组：结果形如 [文本, 路径, 起, 止, 文本, 路径, ...]
  const pieces = text.split(new RegExp(FILE_REF_PATTERN.source, 'g'))
  const nodes: React.ReactNode[] = []

  // 每 4 个一组：0 是前置文本，1/2/3 是三个捕获组
  for (let i = 0; i < pieces.length; i += 4) {
    const plain = pieces[i]
    if (plain) {
      // whitespace-pre-wrap 加在**文本片段自己**身上，而不是外层容器：
      // 容器里混着块级元素（CodeBlock），把 pre-wrap 加在容器上会让浏览器
      // 为块级子元素生成匿名行盒，算出多余高度（气泡上方的空白就是这么来的）。
      nodes.push(
        <span key={`${keyPrefix}-t-${i}`} className="whitespace-pre-wrap">
          {plain}
        </span>,
      )
    }
    const filePath = pieces[i + 1]
    const startLine = pieces[i + 2]
    if (filePath && startLine) {
      const endLine = pieces[i + 3]
      nodes.push(
        <FileRef
          key={`${keyPrefix}-f-${i}`}
          filePath={filePath}
          startLine={Number(startLine)}
          endLine={endLine ? Number(endLine) : undefined}
        />,
      )
    }
  }

  return nodes
}
