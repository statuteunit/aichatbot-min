// scripts/trace.mts
//
// 按 traceId 回放一次 Agent run（product-spec §3.3「可按 run 回放」）。
//
// 它**只读你指定的日志文件**，不连服务器、不查数据库。
// 所以：日志文件必须有内容，而这个内容来自你自己的重定向：
//   pnpm dev 2>&1 | Tee-Object -FilePath .dev.log
//
// 用法（必须 tsx，因为它 import 了 lib/ 下的 .ts）：
//   pnpm exec tsx scripts/trace.mts .dev.log                    # 列出所有 trace
//   pnpm exec tsx scripts/trace.mts .dev.log <traceId>          # 只看某一条
//   pnpm exec tsx scripts/trace.mts .dev.log --verify           # 验收 traceId 一致性
//   pnpm exec tsx scripts/trace.mts .dev.log --events           # 只列事件名（诊断用）
//   pnpm exec tsx scripts/trace.mts .dev.log --raw              # 看文件字节/码点（排查编码）
import { readFileSync, statSync } from 'node:fs'
import {
  parseTraceLines,
  renderTrace,
  verifyTraceCoverage,
} from '../lib/agent/traceReport'

/**
 * 读日志文件并**去掉 BOM / 识别 UTF-16**。
 *
 * 为什么必须处理：Windows PowerShell 的 Tee-Object / Out-File 默认会写
 * UTF-8 BOM（或 UTF-16LE）。带 BOM 时第一行解码成 `\uFEFF{"ts":...}`，
 * JSON.parse 立刻抛错 —— 症状是"文件有 68 行、可解析的 JSON 行 0"，
 * 看起来像路径指错，实际是编码问题。
 */
function readLogFile(path: string): { text: string; encoding: string } {
  const buf = readFileSync(path)

  // UTF-16LE BOM: FF FE   UTF-16BE BOM: FE FF
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.toString('utf16le').replace(/^\uFEFF/, ''), encoding: 'UTF-16LE' }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // Node 没有内置 utf16be，用 swap16 转成 LE 再解码
    const swapped = Buffer.from(buf.subarray(2))
    swapped.swap16()
    return { text: swapped.toString('utf16le'), encoding: 'UTF-16BE' }
  }

  // UTF-8（可能带 BOM: EF BB BF）
  const utf8 = buf.toString('utf8')
  const hasBom = utf8.charCodeAt(0) === 0xfeff
  return { text: hasBom ? utf8.slice(1) : utf8, encoding: hasBom ? 'UTF-8 (BOM)' : 'UTF-8' }
}

const args = process.argv.slice(2)
const source = args[0]
const rest = args.slice(1)

if (!source) {
  console.error('用法: pnpm exec tsx scripts/trace.mts <日志文件|-> [traceId] [--verify] [--events]')
  process.exit(2)
}

let text: string
let detectedEncoding = 'stdin'
if (source === '-') {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  const buf = Buffer.concat(chunks)
  text = buf.toString('utf8').replace(/^\uFEFF/, '')
} else {
  try {
    const read = readLogFile(source)
    text = read.text
    detectedEncoding = read.encoding
  } catch (err) {
    console.error(`读不到日志文件 ${source}：${err instanceof Error ? err.message : err}`)
    console.error('')
    console.error('该命令只读文件，不连服务器。请先生成日志：')
    console.error('  pnpm dev 2>&1 | Tee-Object -FilePath .dev.log')
    process.exit(2)
  }
}

const traceIdArg = rest.find((a) => !a.startsWith('--'))
const verify = rest.includes('--verify')
const eventsOnly = rest.includes('--events')
const rawMode = rest.includes('--raw')

/**
 * --raw：直接展示文件前几行的**字节与码点**。
 *
 * 为什么需要：编码问题（BOM / UTF-16 / 换行）的症状都是"解析不了"，
 * 但成因不同、修法也不同。把字节摆出来就能一次定位，不必往返猜测。
 */
if (rawMode && source !== '-') {
  const buf = readFileSync(source)
  console.log(`文件: ${source}   字节数: ${buf.length}   识别编码: ${detectedEncoding}`)
  console.log(`前 8 字节 (hex): ${[...buf.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`)
  console.log(`前 8 字节 (dec): ${[...buf.subarray(0, 8)].join(' ')}`)
  console.log('')

  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 3)
  lines.forEach((line, i) => {
    console.log(`--- 第 ${i + 1} 个非空行 ---`)
    console.log(`长度: ${line.length}`)
    console.log(`前 20 个码点: ${[...line.slice(0, 20)].map((c) => c.charCodeAt(0)).join(' ')}`)
    console.log(`可见形式: ${JSON.stringify(line.slice(0, 120))}`)
    try {
      JSON.parse(line)
      console.log('JSON.parse: 成功 ✔')
    } catch (err) {
      console.log(`JSON.parse: 失败 ✖  ${err instanceof Error ? err.message : err}`)
    }
    console.log('')
  })
  process.exit(0)
}

/**
 * 诊断信息：文件里到底有什么。
 *
 * 为什么需要它：第一次用这个脚本时报「找不到 traceId」是无信息量的 ——
 * 用户不知道是文件空、还是字段名不对、还是只跑了旧代码。
 * 这里把"文件大小 / JSON 行数 / 出现过的事件名 / 有哪些调用了带 traceId 的事件"
 * 一次性摆出来，失败的成因立刻可见。
 */
function diagnose(): never {
  let size = 0
  try {
    size = statSync(source).size
  } catch {
    // source 是 '-' 时没有文件大小
  }

  const allLines = text.split(/\r?\n/).filter((l) => l.trim())
  const eventCounts = new Map<string, number>()
  const eventsWithTraceId = new Set<string>()
  let jsonLines = 0
  let firstBadLine: string | null = null

  for (const line of allLines) {
    try {
      const o = JSON.parse(line) as Record<string, unknown>
      jsonLines += 1
      const ev = typeof o.event === 'string' ? o.event : '(no-event)'
      eventCounts.set(ev, (eventCounts.get(ev) ?? 0) + 1)
      if (typeof o.traceId === 'string' && o.traceId.length > 0) {
        eventsWithTraceId.add(ev)
      }
    } catch {
      if (firstBadLine === null) firstBadLine = line
    }
  }

  console.error(`日志文件: ${source}${size > 0 ? `  (${(size / 1024).toFixed(1)} KB)` : ''}`)
  console.error(`编码: ${detectedEncoding}   总行数: ${allLines.length}   可解析的 JSON 行: ${jsonLines}`)
  console.error('')

  if (jsonLines === 0) {
    console.error('❗ 文件里有内容，但一行都解析不成 JSON。')
    console.error('')
    if (firstBadLine !== null) {
      // 把开头若干字符的码点打出来：不可见字符（BOM / NUL）会立刻现形
      const head = firstBadLine.slice(0, 40)
      console.error(`   首行前 40 字符的码点: ${[...head].map((c) => c.charCodeAt(0)).join(' ')}`)
      console.error(`   首行可见形式: ${JSON.stringify(head)}`)
      console.error('')
    }
    console.error('   常见原因：')
    console.error('     ① 每行被包了额外字符（如 PowerShell 的格式化输出）；')
    console.error('     ② 文件其实是 UTF-16，但被当 UTF-8 读 —— 本脚本已能自动识别，')
    console.error('        若仍报错请把上面那行"码点"发出来；')
    console.error('     ③ 这个文件不是 dev server 的原始输出（例如 .next/dev/logs/ 下的）。')
    console.error('')
    console.error('   建议重新生成一份干净的日志：')
    console.error('     pnpm dev 2>&1 | Tee-Object -FilePath .dev.log')
  } else {
    console.error('出现过的事件（次数）：')
    for (const [ev, n] of [...eventCounts].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.error(`  ${String(n).padStart(5)}  ${ev}`)
    }
    console.error('')

    if (eventsWithTraceId.size === 0) {
      console.error('❗ 没有任何事件带 traceId 字段。')
      console.error('   最可能的原因：**没有重启 dev server** —— 改动前的代码不写 traceId。')
      console.error('   请停掉当前 dev server（Ctrl+C），重新执行：')
      console.error('     pnpm dev 2>&1 | Tee-Object -FilePath .dev.log')
      console.error('   然后再发一条会触发工具调用的消息（例如"帮我看看 X 是怎么实现的"）。')
    } else {
      console.error(`带 traceId 的事件类型: ${[...eventsWithTraceId].join(', ')}`)
      console.error('')
      console.error('❗ 有带 traceId 的事件，但脚本没解析出 trace。')
      console.error('   这通常意味着日志文件在脚本读取之后才被追加（先运行脚本、后发的消息）。')
      console.error(`   直接重跑：pnpm exec tsx scripts/trace.mts ${source}`)
    }
  }
  process.exit(1)
}

if (eventsOnly) {
  const set = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    try {
      const o = JSON.parse(line) as { event?: string }
      if (typeof o.event === 'string') set.add(o.event)
    } catch {
      /* 非 JSON 行忽略 */
    }
  }
  console.log([...set].sort().join('\n'))
  process.exit(0)
}

const summaries = parseTraceLines(text, traceIdArg ? { traceId: traceIdArg } : {})

if (summaries.length === 0) {
  if (traceIdArg) {
    console.error(`日志里找不到 traceId=${traceIdArg} 的事件。`)
    console.error('')
  }
  diagnose()
}

// 按工具调用条数降序：最"有事发生"的 trace 排前面
summaries.sort((a, b) => b.toolCalls.length - a.toolCalls.length)

for (const s of summaries) {
  console.log(renderTrace(s))
  console.log('')
}

if (verify) {
  const verdict = verifyTraceCoverage(summaries)
  console.log('─'.repeat(64))
  console.log(`验收 traceId：${verdict.passed ? '通过 ✔' : '未通过 ✖'}`)
  console.log(`  发现的 trace 数: ${verdict.traceCount}`)
  console.log(`  含工具调用的 trace 数: ${verdict.tracesWithToolCalls}`)
  console.log(`  traceId 与 requestId 一致的 trace 数: ${verdict.consistentTraces}`)
  for (const r of verdict.reasons) console.log(`  · ${r}`)
  if (!verdict.passed) process.exitCode = 1
}
