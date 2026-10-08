// lib/agent/guard.ts
//
// 重复调用保护与上下文预算。
//   「上下文预算：禁止把整个仓库塞进上下文……单次分析读取文件数 ≤ 30」
//   「检索策略：优先 grep 定位再精读」
// 这些约束原先只写在 system prompt 里 —— 那是**礼貌请求**，不是保证。
// 模型完全可能反复调同一个 grep、或用不同区间把同一个文件读十遍。
// guard 把「礼貌请求」变成代码可拦截的事实。
//
// 为什么必须按请求创建（createCallGuard 是工厂而不是常量）：
//   计数是"单次分析"的语义。如果做成模块级常量，所有用户共享同一份计数——
//   一个用户的分析会把另一个用户的预算吃光。这是一个跨请求状态泄漏 bug。
//   所以 /api/chat 每个请求调用一次 createAgentTools(createCallGuard())。

/** 拦截原因。返回给模型时带 code，让它知道"这是限制，不是故障" */
export interface CallRejection {
  code: 'CALL_LIMIT_EXCEEDED' | 'FILE_BUDGET_EXCEEDED' | 'CONTEXT_BUDGET_EXCEEDED'
  /** 给用户/日志看的中文说明 */
  message: string
  /** 给模型的行动指引——不写清楚它就会重试同一个调用 */
  hint: string
}

export interface GuardOptions {
  maxSameCall?: number
  maxFilesRead?: number        // 保留:防止漫无目的地扫文件
  /** 累计读取的字节上限。这才是真正的上下文预算 —— 见下方说明 */
  maxBytesRead?: number
}

export interface CallGuard {
  check(toolName: string, input: unknown): CallRejection | null
  /** 工具执行完成后回报实际消耗，供累计 */
  report(toolName: string, bytes: number): void
  bytesRead(): number
  /** 已发生的调用总数（含被拦截的），用于日志观测 */
  totalCalls(): number
  /** 已读取的不同文件数，用于日志观测 */
  filesReadCount(): number
}

/**
 * 稳定序列化：让键顺序不影响"同一参数"的判定。
 *
 * 模型可能用 { path, limit } 或 { limit, path } 表达同一个调用，
 * 若直接 JSON.stringify 会被当成两个不同的 key，计数就失效了。
 * 数组顺序保留（[a,b] 与 [b,a] 语义不同），只对对象键排序。
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined'
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

/** 会被计入"读取文件预算"的工具 */
const FILE_READING_TOOLS = new Set(['readFile'])

/**
 * 会被计入**字节预算**的工具。
 *
 * 为什么计量单位必须是字节而不是文件数：
 *   「单次分析读取文件数 ≤ 30」这条约束对 token 消耗几乎没有约束力 ——
 *   读 30 个 10 行的文件无害，读 3 个 3000 行的文件就把上下文烧光了。
 *   实测（2026-10-06）：一次提问 = 1 次 listDir + 7 次 readFile = 14700 prompt tokens。
 *   所以真正的预算要按**输出体积**算，文件数上限只是防"漫无目的扫描"的辅助闸门。
 *
 * grep 也算：开上下文后它的输出可能比 readFile 还大。
 */
const BYTE_BUDGET_TOOLS = new Set(['readFile', 'grep', 'gitLog', 'gitDiff', 'listDir'])

export function createCallGuard(options: GuardOptions = {}): CallGuard {
  const {
    maxSameCall = 2,
    maxFilesRead = 30,
    // 约 400KB：按英文约 4 字符/token 估算，接近 100k tokens 输入。
    // 比模型的上下文窗口保守得多，因为还要留出 system prompt + 历史消息的空间。
    maxBytesRead = 400 * 1024,
  } = options

  const seen = new Map<string, number>()
  const filesRead = new Set<string>()
  let totalCalls = 0
  let bytesReadTotal = 0

  return {
    check(toolName: string, input: unknown): CallRejection | null {
      totalCalls += 1
      const key = `${toolName}:${stableStringify(input)}`
      const count = (seen.get(key) ?? 0) + 1
      seen.set(key, count)

      if (count > maxSameCall) {
        return {
          code: 'CALL_LIMIT_EXCEEDED',
          message: `同一工具与参数已调用 ${count} 次（上限 ${maxSameCall}）`,
          hint: '这个调用已经执行过了，结果没有变化。请改用其他检索方式，或基于已有证据给出结论。',
        }
      }

      if (FILE_READING_TOOLS.has(toolName)) {
        const path = (input as { path?: unknown } | null)?.path
        if (typeof path === 'string' && path) {
          filesRead.add(path)
          if (filesRead.size > maxFilesRead) {
            return {
              code: 'FILE_BUDGET_EXCEEDED',
              message: `单次分析读取的文件数已达上限 ${maxFilesRead}`,
              hint: '上下文预算已用尽。请基于已读取的内容作答，并在报告的"待确认问题"里说明还有哪些文件没看。',
            }
          }
        }
      }

      // 字节预算在执行**前**检查（基于已累计的量）。
      // 注意：这里只能拦住"下一次调用"，当前这一次的实际输出要等 report() 才知道 ——
      // 所以预算是"软上限"，可能略微超出最后一次调用的体积。这是刻意的取舍：
      // 精确控制需要在工具内部逐块计数，复杂度不值得。
      if (BYTE_BUDGET_TOOLS.has(toolName) && bytesReadTotal >= maxBytesRead) {
        return {
          code: 'CONTEXT_BUDGET_EXCEEDED',
          message: `单次分析的上下文预算已用尽（已读取约 ${Math.round(bytesReadTotal / 1024)}KB，上限 ${Math.round(maxBytesRead / 1024)}KB）`,
          hint:
            '不要再检索了。请基于已经读到的内容给出结论，' +
            '并在报告的"待确认问题"里列出还有哪些文件没看、为什么它们可能重要。',
        }
      }

      // 注意：readSensitiveFile 不在此列。
      // 它需要用户逐次批准，却因为"文件预算"被自动拒绝，是荒谬的 ——
      // 用户刚点了批准，却收到"预算是够不上"。审批才是它的闸门。
      return null
    },

    report(toolName: string, bytes: number) {
      if (!BYTE_BUDGET_TOOLS.has(toolName)) return
      if (!Number.isFinite(bytes) || bytes <= 0) return
      bytesReadTotal += bytes
    },

    bytesRead: () => bytesReadTotal,
    totalCalls: () => totalCalls,
    filesReadCount: () => filesRead.size,
  }
}
