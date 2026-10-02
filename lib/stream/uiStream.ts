// lib/stream/uiStream.ts
import type { StreamEvent, ToolTrace, MessageStatus } from '@/types/stream'

export interface StreamState {
  status: MessageStatus
  content: string
  tools: ToolTrace[]
  errorText?: string
}

export const initialStreamState: StreamState = {
  status: 'idle',
  content: '',
  tools: [],
  errorText: '',
}

/**
 * 纯函数 reducer：把协议事件映射为「内容 + 状态」。
 */
export function reduceStreamEvent(state: StreamState, event: StreamEvent): StreamState {
  switch (event.type) {
    case 'start':
      return { ...state, status: 'streaming' }

    case 'text-delta':
      return { ...state, content: state.content + event.delta }

    case 'tool-input-start':
      return {
        ...state,
        status: 'tool',
        tools: [
          ...state.tools,
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            inputText: '',
            status: 'input-streaming',
          },
        ],
      }

    case 'tool-input-delta':
      return {
        ...state,
        tools: state.tools.map((t) =>
          t.toolCallId === event.toolCallId
            ? { ...t, inputText: t.inputText + event.inputTextDelta }
            : t,
        ),
      }

    case 'tool-input-available':
      return {
        ...state,
        tools: state.tools.map((t) =>
          t.toolCallId === event.toolCallId
            ? { ...t, input: event.input, status: 'input-ready' }
            : t,
        ),
      }

    case 'tool-output-available':
      return {
        ...state,
        tools: state.tools.map((t) =>
          t.toolCallId === event.toolCallId
            ? { ...t, output: event.output, status: 'output-ready' }
            : t,
        ),
      }

    case 'tool-output-error':
      return {
        ...state,
        status: 'error',
        tools: state.tools.map((t) =>
          t.toolCallId === event.toolCallId
            ? { ...t, status: 'error', errorText: event.errorText }
            : t,
        ),
      }

    case 'tool-approval-request':
      return { ...state, status: 'approval' }

    case 'error':
      return { ...state, status: 'error', errorText: event.errorText }

    case 'abort':
      // 中断后必须保留已生成内容
      return { ...state, status: 'done' }

    case 'finish':
      return { ...state, status: 'done' }

    case 'text-start':
    case 'text-end':
      return state

    default: {
      // 穷尽性检查：以后往 StreamEvent 里新增协议事件时，这一行会编译报错，
      // 提醒你回来补 reducer 分支。写成函数调用而不是 `const _x: never = event`，
      // 是为了避免产生一个「已赋值但未使用」的变量（eslint 会报）。
      assertNever(event)
      return state
    }
  }
}

/** 编译期穷尽性断言；运行时不做任何事 */
function assertNever(value: never): void {
  void value
}