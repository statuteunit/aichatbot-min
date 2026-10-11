// lib/agent/diff.ts
// unified diff 的解析与校验
// 设计前提：**diff 是来自模型的不可信输入。**
//   **fail-closed**：遇到不认识的结构就返回错误，绝不"跳过继续解析"。
//      宽松的解析器会把风险推迟到 applyPatch才暴露。
//   **只接受 unified diff**：不接受"整文件替换"这类简化格式 ——
//      不可审查的格式等于不可审批
//   **拒绝禁止的操作**：删除、重命名。
//
// 纯函数（输入字符串、输出结构），不碰文件系统
import path from 'node:path'
import { IGNORED_DIRS, isSensitivePath } from './security'

/** diff 校验失败的原因码。设计成稳定字符串，便于前端与日志归类 */
export type DiffRejectionCode =
  | 'EMPTY_DIFF'
  | 'NOT_UNIFIED_DIFF'
  | 'MALFORMED_HUNK'
  | 'HUNK_LINE_COUNT_MISMATCH'
  | 'ABSOLUTE_PATH'
  | 'PATH_TRAVERSAL'
  | 'SENSITIVE_FILE'
  | 'IGNORED_DIRECTORY'
  | 'FILE_DELETION'
  | 'FILE_RENAME'
  | 'TOO_MANY_FILES'
  | 'TOO_LARGE'
  | 'BINARY_DIFF'

export interface DiffFile {
  /** 仓库相对路径（已归一化为正斜杠、去掉 a/ b/ 前缀） */
  path: string
  /**
   * `+++` 行给出的**实际目标路径**。
   *
   * 为什么必须单独保存并校验：`+++` 才是真正被 patch 的文件，
   * 而 `diff --git a/x b/x` 里的路径只是 git 的标签。
   * 只校验后者会留下漏洞 —— `diff --git a/x b/x` + `--- /etc/passwd`
   * 能通过校验，但实际目标是 /etc/passwd。
   */
  targetPath: string | null
  /** 新增文件的基线是「不存在」 */
  isNew: boolean
  /** 被删除的文件 —— V1 禁止，解析成功后也会在 validate 阶段被拒 */
  isDeleted: boolean
  /** 重命名 —— V1 禁止 */
  renamedFrom: string | null
  insertions: number
  deletions: number
}

export interface ParsedDiff {
  files: DiffFile[]
  /** 全部 hunk 的正文总行数，用于体积估算 */
  totalChangedLines: number
}

export type DiffValidation =
  | { ok: true; parsed: ParsedDiff }
  | { ok: false; code: DiffRejectionCode; message: string }

/** 单份提案的文件数上限最多 10 个文件 */
export const MAX_FILES_PER_PROPOSAL = 10
/** 单份提案的 diff 字节上限最多 500KB */
export const MAX_DIFF_BYTES = 500 * 1024

/**
 * 归一化 diff 里的文件路径。
 * 需要处理：git 风格的 `a/src/x.ts` 前缀、Windows 反斜杠、
 * `/dev/null`（新增/删除的标志）。
 */
function normalizeDiffPath(raw: string): string {
  let p = raw.trim()
  // 去掉 git 的 a/ b/ 前缀（只在确实是这两者时才去，避免误伤真的叫 a/ 的目录）
  p = p.replace(/^[ab]\//, '')
  p = p.replace(/\\/g, '/')
  p = p.replace(/^\.\//, '')
  return p
}

/**
 * 判断路径是否违反护栏。
 * 与 resolveWorkspaceFile 的规则**保持一致的语义**，但这里是纯字符串检查
 * （不碰文件系统），因为 diff 里的目标文件可能还不存在。
 * 两处规则的重叠由测试保证（tests/agent/diff.test.ts 覆盖同一批恶意输入）。
 */
function checkPathSafety(p: string): { ok: true } | { ok: false; code: DiffRejectionCode; message: string } {
  if (p.length === 0) {
    return { ok: false, code: 'NOT_UNIFIED_DIFF', message: 'diff 里的文件路径为空' }
  }
  if (p.includes('\0')) {
    return { ok: false, code: 'PATH_TRAVERSAL', message: `路径含空字节：${JSON.stringify(p)}` }
  }
  if (path.isAbsolute(p) || /^[a-zA-Z]:/.test(p)) {
    return { ok: false, code: 'ABSOLUTE_PATH', message: `不接受绝对路径：${p}` }
  }
  const segments = p.split('/').filter((s) => s && s !== '.')
  if (segments.some((s) => s === '..')) {
    return { ok: false, code: 'PATH_TRAVERSAL', message: `路径不得包含 ..：${p}` }
  }
  if (isSensitivePath(segments.join('/'))) {
    return { ok: false, code: 'SENSITIVE_FILE', message: `不接受对敏感文件的改动：${p}` }
  }
  const normalized = segments.join('/')
  for (const ignored of IGNORED_DIRS) {
    if (normalized === ignored || normalized.startsWith(`${ignored}/`)) {
      return { ok: false, code: 'IGNORED_DIRECTORY', message: `不接受对 ${ignored}/ 的改动：${p}` }
    }
  }
  return { ok: true }
}

/**
 * 解析并校验 unified diff。
 * **这是 write 路径的唯一入口** —— 任何要落库的 diff 都必须先过这里。
 * 调用方不要自己解析 diff。
 */
export function parseAndValidateDiff(diff: string): DiffValidation {
  if (typeof diff !== 'string' || diff.trim().length === 0) {
    return { ok: false, code: 'EMPTY_DIFF', message: 'diff 为空' }
  }
  const bytes = Buffer.byteLength(diff, 'utf8')
  if (bytes > MAX_DIFF_BYTES) {
    return {
      ok: false,
      code: 'TOO_LARGE',
      message: `diff 为 ${Math.round(bytes / 1024)}KB，超过上限 ${Math.round(MAX_DIFF_BYTES / 1024)}KB`,
    }
  }
  if (diff.includes('\0')) {
    return { ok: false, code: 'BINARY_DIFF', message: 'diff 含空字节，疑似二进制内容' }
  }
  if (/^GIT binary patch$/m.test(diff) || /^Binary files /m.test(diff)) {
    return { ok: false, code: 'BINARY_DIFF', message: '不支持二进制文件的 diff' }
  }

  const lines = diff.split(/\r?\n/)
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  // 当前 hunk 声明的行数（由 @@ 头给出），用于校验正文是否匹配
  let expectOld = 0
  let expectNew = 0
  let seenOld = 0
  let seenNew = 0
  let inHunk = false
  let totalChangedLines = 0
  let sawAnything = false

  /**
   * 收尾当前 hunk：校验声明的行数是否与正文一致。
   *
   * ⚠️ 只在三种时机调用：遇到新的 `diff --git` / `@@`、循环结束、
   *   以及**计数已经收满**时。**绝不能在循环开头无条件调用** ——
   *   hunk 刚开始时 seenOld=seenNew=0，与声明值必然不等，
   *   会把每一行都判成"行数不符"（这个 bug 实际发生过）。
   */
  const finishHunk = (): DiffValidation | null => {
    if (!inHunk) return null
    if (seenOld !== expectOld || seenNew !== expectNew) {
      return {
        ok: false,
        code: 'HUNK_LINE_COUNT_MISMATCH',
        message:
          `hunk 行数不符：声明 -${expectOld}/+${expectNew}，` +
          `实际 -${seenOld}/+${seenNew}。diff 被截断或伪造。`,
      }
    }
    inHunk = false
    return null
  }

  /** 计数是否已收满（声明值与实际值相等） */
  const hunkComplete = () => seenOld === expectOld && seenNew === expectNew

  for (const rawLine of lines) {
    // 注意：不能用 trim()，行首的空格/`+`/`-` 都是有语义的
    const line = rawLine

    // hunk 已经收满 → 关闭它。之后的零长度行（模板字符串结尾换行产生）
    // 不属于任何 hunk，会被下面的 `if (!inHunk) continue` 忽略。
    //
    // 曾经的 bug：把 `line === ''` 当作"上下文空行"计数。但标准 unified diff 里
    // **上下文空行写作 `" "`（一个空格）**，零长度行只可能是文件末尾的换行残留。
    // 结果每个以换行结尾的 diff 都多算两行，全部报 HUNK_LINE_COUNT_MISMATCH。
    if (inHunk && hunkComplete()) inHunk = false

    if (line.startsWith('diff --git ')) {
      const mismatch = finishHunk()
      if (mismatch) return mismatch
      const m = /^diff --git (\S+) (\S+)$/.exec(line)
      if (!m) {
        return { ok: false, code: 'NOT_UNIFIED_DIFF', message: `无法解析 diff --git 行：${line}` }
      }
      const from = normalizeDiffPath(m[1])
      const to = normalizeDiffPath(m[2])
      current = {
        path: to,
        // 目标路径在下面的 `+++` 行里才有；先置空
        targetPath: null,
        isNew: false,
        isDeleted: false,
        renamedFrom: from !== to ? from : null,
        insertions: 0,
        deletions: 0,
      }
      files.push(current)
      sawAnything = true
      continue
    }

    // 文件头与 hunk 头只有在"不在 hunk 内"时才是结构行。
    // 在 hunk 内出现的 `--- foo` / `+++ foo` 是**被删/被加的内容行**，
    // 不能当作文件头处理（否则 `-`/`+` 开头的代码行会被吞掉，行数也对不上）。
    if (!inHunk) {
      if (line.startsWith('--- ')) {
        const p = normalizeDiffPath(line.slice(4))
        if (p === '/dev/null') {
          // 目标不存在 → 新增文件
          if (current) current.isNew = true
        }
        continue
      }

      if (line.startsWith('+++ ')) {
        const raw = line.slice(4)
        // ⚠️ 必须记下 `+++` 的目标路径并**单独校验**。
        // 它才是真正被 patch 的文件；`diff --git` 里的只是标签。
        // 只校验后者会留下漏洞：`diff --git a/x b/x` + `--- /etc/passwd`
        // 能通过路径检查，但实际写的是 /etc/passwd。
        const p = normalizeDiffPath(raw)
        if (raw.trim() === '/dev/null') {
          // 新内容不存在 → 删除文件（V1 禁止，但先解析出来再统一拒绝）
          if (current) current.isDeleted = true
        } else if (current) {
          current.targetPath = p
        }
        continue
      }
    }

    if (line.startsWith('@@')) {
      const mismatch = finishHunk()
      if (mismatch) return mismatch
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (!m) {
        return { ok: false, code: 'MALFORMED_HUNK', message: `无法解析 hunk 头：${line}` }
      }
      // 省略的长度默认为 1（unified diff 规范）
      expectOld = m[2] === undefined ? 1 : Number(m[2])
      expectNew = m[4] === undefined ? 1 : Number(m[4])
      seenOld = 0
      seenNew = 0
      inHunk = true
      sawAnything = true
      continue
    }

    if (!inHunk) continue

    if (line.startsWith('+')) {
      seenNew += 1
      totalChangedLines += 1
      if (current) current.insertions += 1
    } else if (line.startsWith('-')) {
      seenOld += 1
      totalChangedLines += 1
      if (current) current.deletions += 1
    } else if (line.startsWith(' ')) {
      seenOld += 1
      seenNew += 1
    } else if (line.startsWith('\\')) {
      // `\ No newline at end of file` —— 合法且不影响行数
      continue
    } else if (line === '') {
      // 零长度行：它是 `diff.split()` 的产物（模板字符串结尾换行），
      // **不是 diff 内容**，跳过而不是报错。
      //
      // 为什么不能在这里报 MALFORMED_HUNK：diff 被截断时结尾也有零长度行，
      // 若在这里报错，就永远走不到后面"行数不符"的判断 ——
      // 而"被截断"才是真实故障，错误码必须指向它。
      continue
    } else {
      // 任何非空且无法识别的行。
      // **fail-closed**：不猜、不跳过 —— 宽松解析会把风险推迟到 applyPatch。
      return {
        ok: false,
        code: 'MALFORMED_HUNK',
        message: `hunk 内出现无法识别的行（缺了行首标记？）：${JSON.stringify(line)}`,
      }
    }
  }

  const trailing = finishHunk()
  if (trailing) return trailing

  if (!sawAnything || files.length === 0) {
    return { ok: false, code: 'NOT_UNIFIED_DIFF', message: '不是 unified diff：找不到 diff --git 或 @@ 结构' }
  }

  // 逐个文件校验。
  // ⚠️ 顺序：**先判操作类型（重命名/删除），再判路径安全**。
  //   反过来的话，错误码会取决于路径内容 —— 例如重命名到 .env 会报 SENSITIVE_FILE
  //   而不是 FILE_RENAME，调用方与测试都得猜是哪个规则先命中。
  //   「这个操作 V1 允许吗」是更前置的问题，必须先回答。
  for (const f of files) {
    if (f.renamedFrom) {
      // 源路径也要过一遍安全校验：不允许把敏感文件当作重命名来源
      const fromSafe = checkPathSafety(f.renamedFrom)
      if (!fromSafe.ok) return fromSafe
      return { ok: false, code: 'FILE_RENAME', message: `V1 禁止重命名文件：${f.renamedFrom} → ${f.path}` }
    }
    if (f.isDeleted) {
      return { ok: false, code: 'FILE_DELETION', message: `V1 禁止删除文件：${f.path}` }
    }
    // diff --git 里的路径
    const safe = checkPathSafety(f.path)
    if (!safe.ok) return safe
    // `+++` 给出的真实目标路径 —— 它才是被写入的文件，必须同等校验
    if (f.targetPath !== null && f.targetPath !== f.path) {
      const targetSafe = checkPathSafety(f.targetPath)
      if (!targetSafe.ok) return targetSafe
    }
  }

  if (files.length > MAX_FILES_PER_PROPOSAL) {
    return {
      ok: false,
      code: 'TOO_MANY_FILES',
      message: `涉及 ${files.length} 个文件，超过上限 ${MAX_FILES_PER_PROPOSAL}；请拆分提案`,
    }
  }

  return { ok: true, parsed: { files, totalChangedLines } }
}

/**
 * 变更文件树：把扁平的文件列表整理成可展示的树
 * 返回嵌套结构而不是前端自己拼：
 *   "哪些目录下有改动"是审查时的第一眼信息，两处实现必然漂移。
 */
export interface DiffTreeNode {
  /** 该层的名字（目录名或文件名） */
  name: string
  /** 仓库相对路径 */
  path: string
  type: 'dir' | 'file'
  /** 仅 file 有 */
  insertions?: number
  deletions?: number
  isNew?: boolean
  children?: DiffTreeNode[]
}

export function buildDiffTree(files: readonly DiffFile[]): DiffTreeNode[] {
  const root: DiffTreeNode[] = []

  const findOrCreateDir = (nodes: DiffTreeNode[], name: string, fullPath: string): DiffTreeNode => {
    const existing = nodes.find((n) => n.type === 'dir' && n.name === name)
    if (existing) return existing
    const dir: DiffTreeNode = { name, path: fullPath, type: 'dir', children: [] }
    nodes.push(dir)
    return dir
  }

  for (const file of files) {
    const segments = file.path.split('/')
    let cursor = root
    let prefix = ''
    for (let i = 0; i < segments.length - 1; i += 1) {
      prefix = prefix ? `${prefix}/${segments[i]}` : segments[i]
      const dir = findOrCreateDir(cursor, segments[i], prefix)
      cursor = dir.children as DiffTreeNode[]
    }
    cursor.push({
      name: segments[segments.length - 1],
      path: file.path,
      type: 'file',
      insertions: file.insertions,
      deletions: file.deletions,
      isNew: file.isNew,
    })
  }
  return root
}

/**
 * 把变更文件树渲染成文本，供模型在 tool 输出里看到"我改了什么"。
 * 与 buildDiffTree 配套使用。
 */
export function renderDiffTree(nodes: readonly DiffTreeNode[], indent = 0): string {
  const lines: string[] = []
  const pad = '  '.repeat(indent)
  for (const n of nodes) {
    if (n.type === 'dir') {
      lines.push(`${pad}${n.name}/`)
      lines.push(renderDiffTree(n.children ?? [], indent + 1))
    } else {
      const stat = `+${n.insertions ?? 0} -${n.deletions ?? 0}`
      const flag = n.isNew ? ' (新增)' : ''
      lines.push(`${pad}${n.name}  ${stat}${flag}`)
    }
  }
  return lines.filter((l) => l.length > 0).join('\n')
}