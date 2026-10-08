
// lib/agent/citations.ts
//
// 解决的问题：提示词要求模型「每个事实性结论必须给出 file:line」，
// 但那只是**礼貌请求** —— 模型仍可能引用它从未读过的文件（幻觉路径），
// 或者把路径写错。这里把它变成可检测的事实：
//   把输出里的引用抽出来，与「本次实际通过工具见到过的路径」交叉验证。
//
// 为什么需要调用方传入 seenPaths，而不是在这里自己判断路径是否存在：
//   本模块要保持纯函数（可单测、可跨环境用），不能碰文件系统；
//   「是否真的存在」与「本次是否读到过」是**两个不同的问题**。
//      前者要读盘，后者只依赖本次会话的工具返回。
//      我们关心的是后者：模型**没读过却敢引用**才是幻觉。
export interface Citation {
  path: string
  line?: number
  /** 引用区间时的结束行 */
  endLine?: number
  /**
   * 是否在本次会话的工具返回里真实出现过。
   * false 表示模型引用了一个它从未读到的文件 —— 这是幻觉信号，应当告警。
   */
  verified: boolean
}

/**
 * 匹配 `路径:行号` 或 `路径:行号-行号`。
 *
 * 与 components/fileLink.tsx 的 FILE_REF_PATTERN 保持同一套规则：
 *   - 必须带扩展名（避免把 `12:30`、`useChat:12` 当引用）
 *   - 允许方括号（Next.js 动态路由 `app/api/chats/[id]/route.ts`）
 *   - 行号后不能紧跟数字（避免在 `a.ts:12` 里匹配出 `a.ts:1`）
 *
 * 这里重新声明而不是 import fileLink 的常量：
 *   fileLink.tsx 是 'use client' 组件，服务端 import 它会拉进 React 依赖。
 *   两处规则不一致的风险由各自的测试覆盖（tests/fileRef.test.ts 与
 *   tests/citations.test.ts 使用同一批样例）。
 */
const CITATION_PATTERN =
  /([A-Za-z0-9_@.\-[\]]+(?:[/\\][A-Za-z0-9_@.\-[\]]+)*\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?(?![0-9])/g

/**
 * 从一段文本里抽取所有 `文件路径:行号` 引用，并标记它们是否被真实读到过。
 *
 * @param text      模型输出的原始文本
 * @param seenPaths 本次会话中工具真实返回过的路径集合（相对仓库根，正斜杠）
 * @returns 去重后的引用列表，按出现顺序
 */
export function extractCitations(text: string, seenPaths: Set<string>): Citation[] {
  if (typeof text !== 'string' || text.length === 0) return []

  // 归一化候选集合：统一分隔符与大小写，避免同一个文件因写法不同被判为未验证。
  // Windows 路径不区分大小写，仓储路径在 git 里区分 —— 这里取宽松策略：
  // 宁可把"确实读到过但大小写不同"判为已验证，也不要制造假告警。
  const normalizedSeen = new Set<string>()
  for (const p of seenPaths) {
    normalizedSeen.add(normalizePath(p))
  }

  const found = new Map<string, Citation>()
  // 每次调用重置 lastIndex —— 这个正则有 g 标志，是模块级常量
  CITATION_PATTERN.lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = CITATION_PATTERN.exec(text)) !== null) {
    const rawPath = match[1]
    const line = Number(match[2])
    const endLine = match[3] ? Number(match[3]) : undefined
    const path = normalizePath(rawPath)

    const key = `${path}:${line}`
    if (found.has(key)) continue

    found.set(key, {
      // 保留模型写出来的原始形态，便于在 UI 上按原样展示
      path: rawPath,
      line,
      ...(endLine !== undefined ? { endLine } : {}),
      verified: normalizedSeen.has(path),
    })
  }

  return [...found.values()]
}

/** 统一路径写法：反斜杠转正斜杠、去掉开头的 ./、去掉首尾空白。不改大小写。 */
function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * 只要「未被验证」的引用。
 * 用于：打告警日志、在 UI 上给幻觉引用加标记。
 */
export function unverifiedCitations(text: string, seenPaths: Set<string>): Citation[] {
  return extractCitations(text, seenPaths).filter((c) => !c.verified)
}

/**
 * 从任意工具返回体里递归收集所有看起来像"仓库相对路径"的字符串值。
 *
 * 为什么用递归收集而不是按工具逐个处理：
 *   readFile 返回 `{ path }`、grep 返回 `{ matches: [{ path }] }`、
 *   listDir 返回 `{ entries: [{ path }] }`、gitDiff 返回 `{ files: [...] }` ——
 *   形状各不相同。逐个适配意味着**每加一个工具就要改这里**，很容易漏。
 *   递归找 `path` / `files` / `matches[].path` 这类键，覆盖面更稳。
 *
 * 只收"带扩展名且不含 .."的字符串，避免把 v1.2.3 这类版本号也收进来。
 */
export function collectPaths(output: unknown, into: Set<string>, depth = 0): void {
  if (depth > 6 || output === null || output === undefined) return

  if (typeof output === 'string') {
    // 单个字符串也可能是路径（如 gitDiff 的 files 数组元素）
    if (looksLikeRepoPath(output)) into.add(normalizePath(output))
    return
  }
  if (Array.isArray(output)) {
    for (const item of output) collectPaths(item, into, depth + 1)
    return
  }
  if (typeof output !== 'object') return

  for (const [key, value] of Object.entries(output as Record<string, unknown>)) {
    // 只有这些键才可能是路径，避免把 note / text / message 里的文字当成路径。
    // 不过于宽松是有意的：宁可漏收（少报一次幻觉），也不要误收（假告警）。
    const PATH_KEYS = ['path', 'file', 'files', 'entries', 'matches', 'sources', 'changedFiles']
    if (PATH_KEYS.includes(key)) {
      collectPaths(value, into, depth + 1)
    }
  }
}

/** 粗判是否是仓库内相对路径：有扩展名、不以 / 或盘符开头、不含 .. */
function looksLikeRepoPath(value: string): boolean {
  const v = value.trim()
  if (v.length === 0 || v.length > 300) return false
  if (v.includes('..')) return false
  if (/^([a-zA-Z]:|[\\/])/.test(v)) return false
  return /\.[A-Za-z0-9]{1,10}$/.test(v)
}
