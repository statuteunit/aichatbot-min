// lib/agent/traceReport.ts
//
// trace 聚合与渲染（product-spec §3.3「可按 run 回放」）。
//
// 为什么需要它：光有一个 traceId 落在日志里**验收不了** ——
// 验收要能回答"这一次 run 到底做了什么"，也就是把散落在多行日志里的
// 请求事件 + 每一次工具调用按 traceId 聚起来、按时间排序、渲染成人能读的时间线。
//
// 为什么做成纯函数（输入是字符串、输出是字符串，不读文件）：
//   ① 可被 node:test 直接覆盖 —— 用它才敢改日志字段名；
//   ② 换日志来源（文件 / stdout / DB）时不用改这里；
//   ③ 渲染逻辑与 IO 分离，排查时也能在 REPL 里直接用。

/** 本次 trace 里一次工具调用 */
export interface TraceToolCall {
  tool: string
  ok: boolean
  code: string | null
  durationMs: number
  inputBytes: number
  inputKeys: string | null
  outputBytes: number
  outputHash: string
}

/** 一次完整 trace 的聚合结果 */
export interface TraceSummary {
  traceId: string
  requestIds: string[]
  /** 请求完成的耗时（由 chat.POST 等包装器日志给出） */
  requestDurationMs: number | null
  status: number | null
  events: string[]
  toolCalls: TraceToolCall[]
  finish: {
    promptTokens?: number
    completionTokens?: number
    steps?: number
    readFileCount?: number
    sentMessageCount?: number
    uiMessageCount?: number
    hasSummary?: boolean
    stepsWithText?: number
    finishReason?: string
  } | null
  /** 解析过程中跳过的非 JSON 行数，便于判断输入是否被截断 */
  skippedLines: number
}

type LogLine = Record<string, unknown> & {
  ts?: string
  level?: string
  event?: string
  traceId?: string
  requestId?: string
}

/**
 * 清理一行的不可见前缀字符。
 *
 * 为什么需要：Windows PowerShell 的 Tee-Object / Out-File 可能写入
 * UTF-8 BOM。带 BOM 时第一行变成 `\uFEFF{"ts":...}`，JSON.parse 直接抛错 ——
 * 症状是"文件有 68 行、可解析 0 行"，看起来像路径错，实际是编码问题。
 * 读取端（scripts/trace.mts）已经处理过 BOM，这里再兜一层：
 * 本函数是**纯函数**，容忍脏输入比要求调用方保证干净更可靠。
 */
function stripInvisiblePrefix(line: string): string {
  // \uFEFF = BOM / 零宽不换行空格；\u200B = 零宽空格
  return line.replace(/^[\uFEFF\u200B]+/, '')
}

/**
 * 从多行日志文本里聚合出按 traceId 分组的 trace。
 *
 * 过滤规则：**只认带 `traceId` 字段的行**。
 * 为什么不用 requestId 兜底：两者当前同值，用 requestId 兜底会掩盖
 * "traceId 根本没写进日志"这个真实故障 —— 而验收的目的正是发现它。
 */
export function parseTraceLines(text: string, options: { traceId?: string } = {}): TraceSummary[] {
  const byTrace = new Map<string, TraceSummary>()
  let skippedLines = 0

  for (const raw of text.split(/\r?\n/)) {
    const line = stripInvisiblePrefix(raw.trim())
    if (!line) continue

    let parsed: LogLine
    try {
      parsed = JSON.parse(line) as LogLine
    } catch {
      // Next.js 自己的输出（如 " GET /api/chat 200 in 23.2s"）不是 JSON，正常跳过
      skippedLines += 1
      continue
    }

    const traceId = typeof parsed.traceId === 'string' ? parsed.traceId : undefined
    if (!traceId) continue
    if (options.traceId && traceId !== options.traceId) continue

    let summary = byTrace.get(traceId)
    if (!summary) {
      summary = {
        traceId,
        requestIds: [],
        requestDurationMs: null,
        status: null,
        events: [],
        toolCalls: [],
        finish: null,
        skippedLines: 0,
      }
      byTrace.set(traceId, summary)
    }

    const event = typeof parsed.event === 'string' ? parsed.event : '(no-event)'
    if (!summary.events.includes(event)) summary.events.push(event)

    const requestId = typeof parsed.requestId === 'string' ? parsed.requestId : undefined
    if (requestId && !summary.requestIds.includes(requestId)) {
      summary.requestIds.push(requestId)
    }

    // 工具调用事件
    if (event === 'agent.toolCall') {
      summary.toolCalls.push({
        tool: String(parsed.tool ?? 'unknown'),
        ok: parsed.ok === true,
        code: (parsed.code as string | null) ?? null,
        durationMs: Number(parsed.durationMs ?? 0),
        inputBytes: Number(parsed.inputBytes ?? 0),
        inputKeys: (parsed.inputKeys as string | null) ?? null,
        outputBytes: Number(parsed.outputBytes ?? 0),
        outputHash: String(parsed.outputHash ?? ''),
      })
      continue
    }

    // 请求结束事件：包装器日志带 status/durationMs
    if (typeof parsed.status === 'number') {
      summary.status = parsed.status
      if (typeof parsed.durationMs === 'number') summary.requestDurationMs = parsed.durationMs
    }

    // chat.finish：成本与 KPI
    if (event === 'chat.finish') {
      summary.finish = {
        promptTokens: parsed.promptTokens as number | undefined,
        completionTokens: parsed.completionTokens as number | undefined,
        steps: parsed.steps as number | undefined,
        readFileCount: parsed.readFileCount as number | undefined,
        sentMessageCount: parsed.sentMessageCount as number | undefined,
        uiMessageCount: parsed.uiMessageCount as number | undefined,
        hasSummary: parsed.hasSummary as boolean | undefined,
        stepsWithText: parsed.stepsWithText as number | undefined,
        finishReason: parsed.finishReason as string | undefined,
      }
    }
  }

  // 把 skipped 汇总到每个 summary 上（它们共享同一份输入）
  for (const s of byTrace.values()) s.skippedLines = skippedLines

  return [...byTrace.values()]
}

/**
 * 渲染成可读时间线。
 *
 * 输出刻意包含"traceId 与 requestId 是否一致"这一行 ——
 * 那正是验收项要看的结论，不该让验收人自己去比对两个 uuid。
 */
export function renderTrace(summary: TraceSummary): string {
  const lines: string[] = []
  const { traceId, requestIds } = summary

  lines.push(`trace ${traceId}`)

  // 验收项：traceId 与 requestId 是否一致
  const consistent = requestIds.length > 0 && requestIds.every((id) => id === traceId)
  lines.push(
    `  requestId: ${requestIds.length === 0 ? '(未记录)' : requestIds.join(', ')}` +
    `  → ${consistent ? '与 traceId 一致 ✔' : '与 traceId 不一致 ✖'}`,
  )
  lines.push(`  事件: ${summary.events.join(' → ')}`)
  lines.push(
    `  请求: ${summary.status ?? '?'}  ${summary.requestDurationMs ?? '?'}ms`,
  )

  if (summary.toolCalls.length === 0) {
    lines.push('  工具调用: 无')
  } else {
    lines.push(`  工具调用: ${summary.toolCalls.length} 次`)
    summary.toolCalls.forEach((c, i) => {
      const mark = c.ok ? '✔' : '✖'
      const code = c.code ? ` [${c.code}]` : ''
      lines.push(
        `    ${String(i + 1).padStart(2)}. ${mark} ${c.tool.padEnd(18)}` +
        `${String(c.durationMs).padStart(6)}ms  in=${c.inputBytes}B out=${c.outputBytes}B` +
        `${code}  keys=${c.inputKeys ?? '-'}`,
      )
    })
  }

  if (summary.finish) {
    const f = summary.finish
    lines.push(
      `  完成: reason=${f.finishReason ?? '?'} steps=${f.steps ?? '?'} ` +
      `readFile=${f.readFileCount ?? '?'} stepsWithText=${f.stepsWithText ?? '?'}`,
    )
    lines.push(
      `  token: prompt=${f.promptTokens ?? '?'} completion=${f.completionTokens ?? '?'}` +
      `  消息: 发送 ${f.sentMessageCount ?? '?'}/${f.uiMessageCount ?? '?'}  hasSummary=${f.hasSummary ?? '?'}`,
    )
  } else {
    lines.push('  完成: 未记录 chat.finish（流被中断，或该 trace 未走到结束）')
  }

  if (summary.skippedLines > 0) {
    lines.push(`  (输入里有 ${summary.skippedLines} 行非 JSON，已跳过)`)
  }

  return lines.join('\n')
}

/** 验收判定：给定一份日志，trace 是否可回放 */
export interface TraceVerification {
  traceCount: number
  /** 有工具调用的 trace 数 */
  tracesWithToolCalls: number
  /** traceId 与 requestId 全部一致的 trace 数 */
  consistentTraces: number
  passed: boolean
  reasons: string[]
}

/**
 * 把「traceId 可验收」这个验收项变成一个可执行的判定。
 *
 * 判定标准（对应验收项的实质）：对每一条**有工具调用**的 trace，
 *   ① 日志里确实存在 traceId 字段（parseTraceLines 只认它，所以能进来说明有）
 *   ② 同一条 trace 的 requestId 与 traceId 一致
 *   ③ 工具调用条数 ≥ 1（否则这条 trace 证明不了"工具调用被串起来了"）
 */
export function verifyTraceCoverage(summaries: readonly TraceSummary[]): TraceVerification {
  const reasons: string[] = []
  const withTools = summaries.filter((s) => s.toolCalls.length > 0)

  const consistent = withTools.filter((s) => s.requestIds.every((id) => id === s.traceId))

  if (summaries.length === 0) {
    reasons.push('日志里找不到任何带 traceId 的行 —— traceId 可能根本没写进日志')
  }
  if (withTools.length === 0) {
    reasons.push('没有任何 trace 记录到工具调用 —— 无法验证"工具调用被串进 trace"')
  }
  if (withTools.length > 0 && consistent.length !== withTools.length) {
    const bad = withTools.filter((s) => !s.requestIds.every((id) => id === s.traceId))
    reasons.push(
      `有 ${bad.length} 条 trace 的 requestId 与 traceId 不一致：` +
      bad.map((s) => s.traceId).join(', '),
    )
  }

  return {
    traceCount: summaries.length,
    tracesWithToolCalls: withTools.length,
    consistentTraces: consistent.length,
    passed: reasons.length === 0,
    reasons,
  }
}
