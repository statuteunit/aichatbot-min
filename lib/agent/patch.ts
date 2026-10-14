// lib/agent/patch.ts
// 把 unified diff **应用在内存里**，算出目标内容。
// ⚠️ 本文件是纯函数：输入原文 + diff，输出新文；不碰文件系统。
//    真正的落盘在 lib/agent/apply.ts。
//      重建内容的正确性可以用穷举测试证明，而落盘的正确性只能靠
//      "原子写 + 回滚"的机制保证 —— 两类问题混在一个文件里会互相掩护。
//
// ⚠️ 与 lib/agent/diff.ts 的分工：
//      diff.ts  = 入口校验（路径护栏、行数自洽、禁止操作）
//      patch.ts = 内容重建（给定原文，算出新文）
//    两者都要校验 hunk 行数，这是刻意的重复：patch.ts 可能被单独调用
//    （比如测试），不能假设调用方已经跑过 diff.ts。
import { MAX_DIFF_BYTES, parseAndValidateDiff, type DiffRejectionCode } from './diff'
import { createHash } from 'node:crypto'

/** 应用失败的原因码（复用 diff.ts 的校验码与 patch 特有的重建码） */
export type PatchRejectionCode =
  | DiffRejectionCode
  | 'HUNK_CONTEXT_MISMATCH'
  | 'HUNK_RANGE_INVALID'
  | 'NO_NEWLINE_UNSUPPORTED'

export interface PatchHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** 逐行，含行首标记（` ` / `+` / `-`）；已剔除 `\ No newline` 这类元信息行 */
  lines: string[]
}

export interface FilePatch {
  /** 来自 `diff --git a/x b/x` 的 b 侧路径 */
  path: string
  isNew: boolean
  hunks: PatchHunk[]
}

export type ParseFilePatchResult =
  | { ok: true; path: string; patchIndex: number; isNew: boolean }
  | { ok: false; code: PatchRejectionCode; message: string }

/** 单文件的补丁方案：原文、目标内容、两侧 hash 都要留痕，供审批与幂等判定 */
export interface PatchFilePlan {
  path: string
  existsBefore: boolean
  originalContent: string
  targetContent: string
  baseHash: string
  targetHash: string
}

// 解析补丁文件列表

function normalizePath(raw: string): string {
  return raw
    .trim()
    .replace(/^[ab]\//, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
}

function fail(code: PatchRejectionCode, message: string): { ok: false; code: PatchRejectionCode; message: string } {
  return { ok: false, code, message }
}

/**
 * 解析出 diff 里每个文件各自属于哪个补丁块、是否新增。
 *
 * 为什么不用已有的 ParsedDiff：它只保留了路径与统计行数，
 * 没有"这个文件从第几个块开始"的定位信息，无法据此取回正文。
 */
function splitFilePatches(diff: string): { path: string; lines: string[] }[] {
  const lines = diff.split(/\r?\n/)
  const out: { path: string; lines: string[] }[] = []
  let currentPath = ''
  let buffer: string[] = []
  let started = false

  const flush = () => {
    if (started && currentPath) out.push({ path: currentPath, lines: buffer })
  }

  for (const line of lines) {
    // 只在 hunk 之外认 `diff --git`；hunk 内它是内容行
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git (\S+) (\S+)$/.exec(line)
      // m 的判空是类型收窄，不是冗余检查：无效的 diff 头既不能当文件头，
      // 也不能 push 进 buffer（否则会污染上一个文件的行数校验）。
      if (m) {
        flush()
        currentPath = normalizePath(m[2])
        buffer = []
        started = true
        continue
      }
    }
    if (started) {
      if (line === '') continue
      buffer.push(line)
    }
  }
  flush()
  return out
}

// 校验单个补丁块

/**
 * 校验一个 hunk 的正文与头部声明是否自洽。
 * 逻辑与 diff.ts 的 finishHunk 同构 —— 见文件头对"刻意重复"的说明。
 */
function validateHunk(hunk: PatchHunk, path: string): ReturnType<typeof fail> | { ok: true } {
  let seenOld = 0
  let seenNew = 0
  for (const line of hunk.lines) {
    if (line.startsWith('+')) seenNew += 1
    else if (line.startsWith('-')) seenOld += 1
    else if (line.startsWith(' ') || line === '') {
      seenOld += 1
      seenNew += 1
    } else {
      return fail('HUNK_CONTEXT_MISMATCH', `${path}：hunk 内出现无法识别的行 ${JSON.stringify(line)}`)
    }
  }
  if (seenOld !== hunk.oldLines || seenNew !== hunk.newLines) {
    return fail(
      'HUNK_CONTEXT_MISMATCH',
      `${path}：hunk 行数不符，声明 -${hunk.oldLines}/+${hunk.newLines}，实际 -${seenOld}/+${seenNew}`,
    )
  }
  return { ok: true }
}

/**
 * 解析全部文件补丁。
 *
 * ⚠️ `\ No newline at end of file` 一律**拒绝**（NO_NEWLINE_UNSUPPORTED）。
 *    为什么不做支持：它要求"末行不带换行"，会让重建逻辑多出一种边界状态，
 *    而边界状态正是回滚与幂等判定最容易出错的地方。
 *    V1 的取舍是**明确拒绝并告知模型去掉这类改动**，而不是悄悄按带换行处理
 *    —— 后者会写入一个与提案不完全一致的文件。
 */
export function parseFilePatches(diff: string): { ok: true; files: FilePatch[] } | { ok: false; code: PatchRejectionCode; message: string } {
  if (typeof diff !== 'string' || diff.trim().length === 0) {
    return fail('EMPTY_DIFF', 'diff 为空')
  }
  if (Buffer.byteLength(diff, 'utf8') > MAX_DIFF_BYTES) {
    return fail('TOO_LARGE', `diff 超过 ${Math.round(MAX_DIFF_BYTES / 1024)}KB 上限`)
  }
  if (diff.includes('\\ No newline at end of file')) {
    return fail(
      'NO_NEWLINE_UNSUPPORTED',
      'diff 含「\\ No newline at end of file」。V1 要求所有文件以换行结尾，请去掉这个改动',
    )
  }

  const blocks = splitFilePatches(diff)
  if (blocks.length === 0) {
    return fail('NOT_UNIFIED_DIFF', '找不到任何 diff --git 块')
  }

  const files: FilePatch[] = []
  for (const block of blocks) {
    let isNew = false
    const hunks: PatchHunk[] = []
    let current: PatchHunk | null = null

    const closeHunk = () => {
      if (current) hunks.push(current)
      current = null
    }

    for (const line of block.lines) {
      if (line.startsWith('--- ')) {
        if (line.slice(4) === '/dev/null') isNew = true
        continue
      }
      if (line.startsWith('+++ ')) {
        // b 侧路径以 `diff --git` 的第二个参数为准，这里不覆盖
        continue
      }
      if (line.startsWith('@@')) {
        closeHunk()
        const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
        if (!m) return fail('MALFORMED_HUNK', `${block.path}：无法解析 hunk 头 ${line}`)
        current = {
          oldStart: Number(m[1]),
          oldLines: m[2] === undefined ? 1 : Number(m[2]),
          newStart: Number(m[3]),
          newLines: m[4] === undefined ? 1 : Number(m[4]),
          lines: [],
        }
        continue
      }
      if (current) {
        if (line.startsWith('\\')) continue
        if (line === '') continue
        // 解析diff去掉行尾/r
        current.lines.push(line.replace(/\r$/, ''))
      }
      // 其余行（index 行、mode 行等）忽略
    }
    closeHunk()

    for (const hunk of hunks) {
      const valid = validateHunk(hunk, block.path)
      if (!valid.ok) return valid
    }

    files.push({ path: block.path, isNew, hunks })
  }

  return { ok: true, files }
}

/**
 * 按 patchIndex 取回某个文件的补丁。
 *
 * 用"索引"当键而不是"路径"：同一份 diff 里理论上可能出现同路径多个
 * `diff --git` 块，用路径做键会静默丢一个。索引没有这个歧义。
 */
export function findFilePatch(files: readonly FilePatch[], patchIndex: number): FilePatch | null {
  return files[patchIndex] ?? null
}

// 内容应用

/** 把补丁块逐个应用到原文上，重建成目标内容 */
function applyHunks(
  original: string,
  hunks: readonly PatchHunk[],
  path: string,
): { ok: true; text: string } | { ok: false; code: PatchRejectionCode; message: string } {
  const hadTrailingNewline = original.endsWith('\n')
  // 行尾归一化：本 checkout 的文件是 CRLF（git core.autocrlf=true 且无 .gitattributes），
  // 而模型给出的 unified diff 是 LF。若不归一化，磁盘每行末尾都带一个 \r，
  // 与 diff 里的上下文行永远不相等 —— 每个 hunk 都会在第一个上下文行报
  // HUNK_CONTEXT_MISMATCH，看起来却像“基线漂移”。
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  const normalized = eol === '\r\n' ? original.replace(/\r\n/g, '\n') : original
  const rawLines = normalized.split('\n')
  const lines = hadTrailingNewline ? rawLines.slice(0, -1) : rawLines

  const out: string[] = []
  let cursor = 0

  for (const hunk of hunks) {
    // 空 hunk 的新增文件写作 `@@ -0,0 +1,N @@`：oldStart=0 表示“零行文件”，而不是“第 0 行”。
    // 不减一，直接落到 0。
    const declaredStart = hunk.oldLines === 0 && hunk.oldStart === 0 ? 0 : hunk.oldStart - 1
    // 用 hunk 的第一行当锚点在文件里确认真实起点。unified diff 允许省略相邻 hunk
    // 之间的中间行，行号也就完全可能对不上（git 的 hunk 不以上下文行结尾时就会这样），
    // 因此不能直接信任 oldStart。
    const first = hunk.lines[0]
    const probe =
      first === undefined || first === '' || first.startsWith('\\')
        ? lines.length
        : first.startsWith('-')
          ? first.slice(1)
          : first.startsWith('+')
            ? null
            : first.slice(1)
    const MAX_LOOKAHEAD = 5
    let start = declaredStart
    if (probe !== null) {
      const searchStart = Math.max(Math.max(cursor, declaredStart - MAX_LOOKAHEAD), 0)
      let found = -1
      for (let i = searchStart; i < lines.length && i <= declaredStart + MAX_LOOKAHEAD; i += 1) {
        if (lines[i] === probe) {
          found = i
          break
        }
      }
      if (found < 0) {
        return fail(
          'HUNK_CONTEXT_MISMATCH',
          `${path}：hunk 起始行 ${hunk.oldStart} 附近找不到上下文 ${JSON.stringify(probe)}` +
          `（在 ${searchStart + 1}~${Math.min(declaredStart + MAX_LOOKAHEAD + 1, lines.length)} 行之间查找）。` +
          '工作区已被改动，提案不再适用。',
        )
      }
      start = found
    }
    if (start < cursor || start > lines.length) {
      return fail(
        'HUNK_RANGE_INVALID',
        `${path}：hunk 起始行 ${hunk.oldStart} 越界或与上一处重叠（文件共 ${lines.length} 行）`,
      )
    }
    // 未涉及的行原样保留。
    // 必须把 cursor 推进到 start —— 这些行虽然不参与本 hunk 的比对，
    // 但它们确实属于本 hunk 之前的位置。忘了推进会让下面的比对从更早的
    // 行开始，进而报出「上下文不符」这种看起来像基线漂移、实际是定位错位的错误。
    for (let i = cursor; i < start; i += 1) out.push(lines[i])
    cursor = start

    for (const line of hunk.lines) {
      if (line.startsWith('-')) {
        const expected = line.slice(1)
        if (lines[cursor] !== expected) {
          return fail(
            'HUNK_CONTEXT_MISMATCH',
            `${path}:${cursor + 1} 待删除内容不符。` +
            `diff 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(lines[cursor] ?? null)}。` +
            '工作区已被改动，提案不再适用。',
          )
        }
        cursor += 1
      } else if (line.startsWith('+')) {
        out.push(line.slice(1))
      } else {
        // 上下文行：必须与磁盘一致，否则说明基线已变
        const expected = line.startsWith(' ') ? line.slice(1) : ''
        if (lines[cursor] !== expected) {
          return fail(
            'HUNK_CONTEXT_MISMATCH',
            `${path}:${cursor + 1} 上下文不符。` +
            `diff 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(lines[cursor] ?? null)}。` +
            '工作区已被改动，提案不再适用。',
          )
        }
        out.push(lines[cursor])
        cursor += 1
      }
    }
  }

  for (let i = cursor; i < lines.length; i += 1) out.push(lines[i])
  // 保持原有"是否以换行结尾"的性质，避免无意义地改动文件末尾
  return { ok: true, text: out.join(eol) + (hadTrailingNewline ? eol : '') }
}

/**
 * 根据原文与补丁重建目标内容。
 *
 * `baseFileContents` 里缺某个路径时视为空字符串 ——
 * 「新增文件」的基线就是空。
 */
export function buildTargetFiles(
  originalDiff: string,
  baseFileContents: Record<string, string>,
): { ok: true; plans: PatchFilePlan[] } | { ok: false; code: PatchRejectionCode; message: string } {
  // ① 先过 diff.ts 的入口校验（路径护栏、禁止删除/重命名、体积、文件数）
  const validation = parseAndValidateDiff(originalDiff)
  if (!validation.ok) return fail(validation.code, validation.message)

  // ② 再解析正文
  const parsed = parseFilePatches(originalDiff)
  if (!parsed.ok) return parsed

  const plans: PatchFilePlan[] = []
  for (let i = 0; i < validation.parsed.files.length; i += 1) {
    const meta = validation.parsed.files[i]
    const patch = findFilePatch(parsed.files, i)
    if (!patch) {
      return fail('NOT_UNIFIED_DIFF', `diff 元信息与正文块数量不一致（第 ${i + 1} 个文件）`)
    }
    const original = baseFileContents[meta.path] ?? ''
    if (meta.isNew && original.length > 0) {
      return fail('HUNK_CONTEXT_MISMATCH', `${meta.path}：提案标记为新增文件，但磁盘上已存在内容`)
    }
    const applied = applyHunks(original, patch.hunks, meta.path)
    if (!applied.ok) return applied
    const target = applied.text
    plans.push({
      path: meta.path,
      existsBefore: original.length > 0,
      originalContent: original,
      targetContent: target,
      baseHash: hashText(original),
      targetHash: hashText(target),
    })
  }
  return { ok: true, plans }
}

/**
 * 为什么不 import 它的 sha256：那会引入一条 patch.ts → workspace.ts 的依赖，
 * 而 workspace.ts 会读文件系统。本文件要保持"纯函数、零 I/O"，
 * 才能被测试穷举。算法一致性由 tests/agent/patch.test.ts 交叉验证。
 */
function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}