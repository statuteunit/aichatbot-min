// lib/agent/normalizeDiff.ts
//
// 按正文重算 hunk 头的行数。
//
// 为什么可以做：hunk 头的行数是**冗余信息** ——
//   oldLines = 本 hunk 内「空格开头」+「减号开头」的行数
//   newLines = 本 hunk 内「空格开头」+「加号开头」的行数
// 完全可以从正文推出来，没有必须让模型手算的道理。
// 避免模型计算错误导致"声明与实际不符"
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export interface NormalizeDiffResult {
  diff: string
  /** 被修正的 hunk 数（0 = 原文没动） */
  repairedHunks: number
  /** 无法修正的畸形头（如裸 `@@`），原样保留，交给下游校验器报错 */
  malformedHeaders: string[]
}

export function normalizeHunkHeaders(diff: string): NormalizeDiffResult {
  const lines = diff.split('\n')
  const out: string[] = []
  const malformedHeaders: string[] = []
  let repairedHunks = 0

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const m = HUNK_HEADER.exec(line)
    if (!m) {
      if (line.startsWith('@@')) malformedHeaders.push(line)
      out.push(line)
      i += 1
      continue
    }

    // 收集正文：到下一个 hunk 头 / 下一个文件头 / 结尾为止。
    // 不能按「声明行数」收集 —— 声明值本身可能就是错的，那正是要修的东西。
    const body: string[] = []
    let j = i + 1
    while (
      j < lines.length &&
      !HUNK_HEADER.test(lines[j]) &&
      !lines[j].startsWith('@@') &&
      !lines[j].startsWith('diff --git ')
    ) {
      body.push(lines[j])
      j += 1
    }

    // `\ No newline at end of file` 是元信息行，不计入任何一侧
    const counted = body.filter((l) => l !== '' && !l.startsWith('\\'))
    const oldCount = counted.filter((l) => l.startsWith(' ') || l.startsWith('-')).length
    const newCount = counted.filter((l) => l.startsWith(' ') || l.startsWith('+')).length

    const declared = `${m[2] ?? '1'}/${m[4] ?? '1'}`
    if (declared !== `${oldCount}/${newCount}`) {
      repairedHunks += 1
      out.push(`@@ -${m[1]},${oldCount} +${m[3]},${newCount} @@`)
    } else {
      out.push(line)
    }
    out.push(...body)
    i = j
  }

  return { diff: out.join('\n'), repairedHunks, malformedHeaders }
}