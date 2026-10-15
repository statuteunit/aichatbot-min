// components/diffView.tsx
//
// unified diff 的行级着色。纯展示：不取数、不加 "use client"，两端都能用。
// 为什么只做"行首字符分类"而不做 diff 计算：
//   是否可应用由 lib/agent/diff.ts 决定，着色只是展示问题，两者混在一起会互相污染。

type LineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context'

function classify(raw: string): LineKind {
  if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('diff ') || raw.startsWith('index ')) {
    return 'meta'
  }
  if (raw.startsWith('@@')) return 'hunk'
  if (raw.startsWith('+')) return 'add'
  if (raw.startsWith('-')) return 'del'
  return 'context'
}

const LINE_STYLE: Record<LineKind, string> = {
  add: 'bg-emerald-50 text-emerald-800',
  del: 'bg-red-50 text-red-800',
  hunk: 'bg-sky-50 text-sky-700',
  meta: 'text-gray-500 font-medium',
  context: 'text-gray-700',
}

export function DiffView({ diff, maxLines = 400 }: { diff: string; maxLines?: number }) {
  // 归一化 EOL：仓库在 Windows 上可能是 CRLF，浏览器里多出的 \r 会变成方块
  const lines = diff.replace(/\r\n/g, '\n').split('\n')
  const shown = lines.slice(0, maxLines)

  return (
    <div className="overflow-x-auto rounded-md border border-gray-200 bg-white">
      <pre className="min-w-full text-xs leading-5">
        {shown.map((raw, index) => {
          const kind = classify(raw)
          return (
            <div key={index} className={`whitespace-pre px-3 py-0.5 font-mono ${LINE_STYLE[kind]}`}>
              {raw || ' '}
            </div>
          )
        })}
      </pre>
      {lines.length > shown.length ? (
        <p className="border-t border-gray-200 px-3 py-1 text-xs text-gray-500">
          仅显示前 {shown.length} 行，共 {lines.length} 行
        </p>
      ) : null}
    </div>
  )
}