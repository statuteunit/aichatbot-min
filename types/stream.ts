// types/stream.ts
/** 消息展示状态：流式输出的六种状态 */
export type MessageStatus =
  | 'idle'       // 已创建，尚未请求
  | 'streaming'  // 正在接收文本增量
  | 'tool'       // 正在执行/接收工具调用
  | 'approval'   // 等待用户批准
  | 'error'      // 流式过程中出错
  | 'done'       // 正常结束

/** 消费的最小协议子集 */
export type StreamEvent =
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'tool-input-start'; toolCallId: string; toolName: string }
  | { type: 'tool-input-delta'; toolCallId: string; inputTextDelta: string }
  | { type: 'tool-input-available'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool-output-available'; toolCallId: string; output: unknown }
  | { type: 'tool-output-error'; toolCallId: string; errorText: string }
  | { type: 'tool-approval-request'; approvalId: string; toolCallId: string }
  | { type: 'error'; errorText: string }
  | { type: 'abort'; reason?: string }
  | { type: 'start' }
  | { type: 'finish' }

/** 工具调用的展示用轨迹 */
export interface ToolTrace {
  toolCallId: string
  toolName: string
  inputText: string        // 流式累积的原始输入文本
  input?: unknown          // 解析完成后的输入
  output?: unknown
  status: 'input-streaming' | 'input-ready' | 'output-ready' | 'error' | 'denied'
  errorText?: string
}