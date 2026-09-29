// lib/stream/sse.ts
// 按agent的规范重新切割流式输出的内容
/** 按 SSE 规范切分：一个事件以空行结束；data: 可能有多行 */
export function createSseParser() {
  let buffer = ''
  return function parse(chunk: string): string[] {
    buffer += chunk
    const events: string[] = []
    let idx: number
    // 空行（\n\n 或 \r\n\r\n）才是事件边界
    while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const raw = buffer.slice(0, idx)
      buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, '')
      const data = raw
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        // SSE 规范：冒号后最多剥掉一个空格，其余（含缩进）保留
        .map((l) => {
          const after = l.slice(5)
          return after.startsWith(' ') ? after.slice(1) : after
        })
        .join('\n')
      if (data) events.push(data)
    }
    return events
  }
}