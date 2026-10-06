// hooks/useChat.ts
//
// 从"自研 SSE 解析 + 六态状态机"迁移到 @ai-sdk/react 的 useChat
//
// 后端 app/api/chat/route.ts 已经改为产出 AI SDK 的 UI Message Stream
// （result.toUIMessageStreamResponse()），协议与 useChat 原生匹配。
// 因此 lib/stream/uiStream.ts 的 reducer 与 lib/stream/sse.ts 的解析器不再被使用。
//
// 关键设计：chatId / model / mode 必须随每次请求发送给服务端
// （服务端据此落库、选模型、读会话模式）。
// DefaultChatTransport 的 body 接受 Resolvable<object>，写成函数即可读到最新值，
// 不需要为了切换会话重建 transport。
'use client'

import { useEffect, useState } from 'react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { useChat as useAiChat } from '@ai-sdk/react'
import type { MessageStatus } from '@/types/stream'
import { logEvent } from '@/lib/logging'

interface UseChatOptions {
  chatId?: string
  api?: string
  model?: string
  /**
   * 会话模式。仅在「新会话尚未落库」的窗口期有意义——
   * 服务端始终以数据库里的 Chat.mode 为准（不可由客户端伪造）。
   */
  mode?: string
  initialMessages?: UIMessage[]
}

interface UseChatReturn {
  messages: UIMessage[]
  input: string
  setInput: (value: string) => void
  /** 有任何请求在跑（已提交或流式中） */
  isBusy: boolean
  /** 仅流式接收文本/工具事件阶段为 true */
  isStreaming: boolean
  /** 六态展示状态；由 useChat 的 status 与 tool parts 推导 */
  status: MessageStatus
  error: Error | undefined
  sendMessage: (text: string) => void
  regenerate: () => void
  stop: () => void
  setMessages: (messages: UIMessage[]) => void
  /** 清空当前消息（切会话前调用） */
  reset: () => void
  /** 对 needsApproval 的工具做出批准/拒绝决定 */
  respondToApproval: (params: { id: string; approved: boolean; reason?: string }) => void
}

/** useChat 的 status → 展示六态的映射（tool / approval 由消息内容进一步细分） */
function deriveStatus(
  chatStatus: 'submitted' | 'streaming' | 'ready' | 'error',
  messages: UIMessage[],
): MessageStatus {
  if (chatStatus === 'error') return 'error'
  if (chatStatus === 'ready') return 'done'
  if (chatStatus === 'submitted') return 'streaming'

  // streaming：看最后一条助手消息里有没有正在进行的工具调用
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
  const parts = lastAssistant?.parts ?? []

  // 是否在等用户批准。
  // 注意：审批不是独立的 part 类型——它就挂在 tool part 上，
  // 把 state 写成 'tool-approval-request' 是错的（这个 type 不存在），
  // 会导致状态徽标永远显示「工具调用中」而不是「等待批准」。
  const hasApproval = parts.some((part) => {
    if (!part.type.startsWith('tool-') && part.type !== 'dynamic-tool') return false
    return (part as { state?: string }).state === 'approval-requested'
  })
  if (hasApproval) return 'approval'

  // 有工具在跑：state 处于「参数生成中 / 执行中」。
  // 这里也要按 state 判断，而不是靠 type 前缀猜——
  // 'tool-xxx' 在工具完成的整个生命周期里都是同一个 type，
  // 只有 state 能区分「正在跑」与「已完成」。
  const RUNNING_STATES = new Set(['input-streaming', 'input-available'])
  const hasRunningTool = parts.some((part) => {
    if (!part.type.startsWith('tool-') && part.type !== 'dynamic-tool') return false
    return RUNNING_STATES.has((part as { state?: string }).state ?? '')
  })
  if (hasRunningTool) return 'tool'
  return 'streaming'
}

/**
 * 当前请求参数（会话 id + 模型）
 *
 * 为什么放在模块作用域而不是 useRef：
 *   官方推荐的动态配置写法是给 transport 传函数（`body: () => getCurrentSessionId()`），
 *   而 React 19 的 react-hooks/refs 规则会因为「把一个 ref 传进函数」就判定
 *   "may read its value during render"（保守判定，见 facebook/react#37521）。
 *   改用普通模块变量承载运行期数据、由 effect 更新，规则与意图就一致了：
 *   渲染期不读任何 ref，请求发出时才读取这里的值。
 *
 * 单实例约束：本 hook 只被 Chat 组件使用一次。若将来出现多个 chat 实例，
 * 这里需要改成按实例 key 存储（Map）。
 */
const requestPayload: {
  chatId: string | null
  model: string | undefined
  mode: string | undefined
} = {
  chatId: null,
  model: undefined,
  mode: undefined,
}

/**
 * 消息 / 会话 id 生成器。
 *
 * ⚠️ 必须显式提供，不能依赖 SDK 默认行为。
 *
 * 实测（2026-10-06 日志）：不传 generateId 时，Assistant 响应消息的 id 是**空字符串**：
 *     {"event":"diag.chat.onFinish","messageId":"","contentLength":1899}
 *     {"event":"diag.persist.upsert","messageIdType":"string","messageIdLength":0}
 *
 * 空字符串会造成灾难性后果 —— 它满足 TEXT NOT NULL，也满足主键唯一性，
 * 于是 upsertAssistantMessage 的 upsert 从第二次起一直在**覆盖同一行**：
 *     upsert({ where: { id: '' }, update: { content }, ... })
 * 表现为「AI 消息经常丢失」，实际是每次都覆盖上一条。
 *
 * 用 crypto.randomUUID（浏览器与 Node 都原生支持）保证非空且唯一。
 * 与服务端 messageId 兜底（chatRepository.upsertAssistantMessage）构成双保险。
 */
function createStableId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  // 极端回退：没有 Web Crypto 的环境。仍然保证非空
  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`
}

export function useChat(options: UseChatOptions = {}): UseChatReturn {
  const { chatId, api = '/api/chat', model, mode, initialMessages = [] } = options

  const [input, setInput] = useState('')

  // 每次参数变化时同步到模块作用域，供 transport 在请求时读取。
  // 写在 effect 里而不是渲染期，避免"渲染期更新外部状态"。
  useEffect(() => {
    requestPayload.chatId = chatId ?? null
    requestPayload.model = model
    requestPayload.mode = mode
  }, [chatId, model, mode])

  // transport 只创建一次；body 是函数，官方支持的动态配置写法
  const [transport] = useState(
    () =>
      new DefaultChatTransport<UIMessage>({
        api,
        body: () => ({
          chatId: requestPayload.chatId,
          model: requestPayload.model,
          mode: requestPayload.mode,
        }),
      }),
  )

  // 供错误日志使用的最新 chatId。
  // 直接读模块作用域的 requestPayload（在回调里读，渲染期不碰）。
  const chat = useAiChat({
    transport,
    messages: initialMessages,
    /**
     * 显式提供 id 生成器。
     * 不传的话 SDK 会给响应消息一个**空字符串 id**，导致落库时所有 AI 消息
     * 挤在同一个主键上互相覆盖（详见文件内 createStableId 的说明）。
     */
    generateId: createStableId,
    /**
     * 审批后自动续流。
     *
     * 为什么必须配：needsApproval 的工具被调用时，服务端**不执行**它，
     * 而是发一个 tool-approval-request 并结束这一轮。用户点「批准」后，
     * 客户端把决定写回消息——但**如果不返回 true，消息不会发回服务端**，
     * 界面会停在「已决定，等待继续」不动，看起来像卡死。
     *
     * 判定依据：最后一条消息里存在 state === 'approval-responded' 的工具 part，
     * 即「用户已经做了决定但服务端还不知道」。
     */
    sendAutomaticallyWhen: ({ messages: currentMessages }) => {
      const last = currentMessages[currentMessages.length - 1]
      if (!last) return false
      return last.parts.some((part) => {
        if (!part.type.startsWith('tool-') && part.type !== 'dynamic-tool') return false
        return (part as { state?: string }).state === 'approval-responded'
      })
    },
    onError: (err) => {
      // 服务端的统一错误体（含 requestId）会出现在 message 里；
      // 前端失败时至少要能在控制台对上服务端日志
      logEvent('error', 'chat.clientError', {
        chatId: requestPayload.chatId,
        error: err instanceof Error ? err.message : String(err),
      })
    },
  })

  const { messages, status: chatStatus, error } = chat

  const status = deriveStatus(chatStatus, messages)
  const isBusy = chatStatus === 'submitted' || chatStatus === 'streaming'
  const isStreaming = chatStatus === 'streaming'

  // ⚠️ 这里**故意没有**「按 chatId 变化清空消息」的 effect。
  //
  // 原实现靠 effect 比较 prevChatIdRef 来推断「会话切换了」然后清空，但它会清掉
  // **刚加载完的历史**：加载流程是
  //     setMessages(pageMessages)   // 写入 6 条
  //     setCurrentChatId(chatId)    // 触发重渲染 → effect 发现 chatId 变了 → 清空
  // 实测日志（HMR 重启后复现）：
  //     [diag] 拉取历史成功 { convertedCount: 6 }
  //     [diag] reset effect { from: undefined, to: '<id>', messagesBeforeClear: 6 }
  //     [diag] messages changed -> 6
  //     [diag] messages changed -> 0     ← 历史被清空，界面空白
  //
  // 而且它的依赖数组含 `chat`（SDK 每次渲染返回的新对象），effect 实际每次渲染都跑，
  // 完全依赖 ref 守卫——渲染顺序稍有变化就会误清。
  //
  // 改为由调用方**显式** reset()（见 components/chat.tsx 的 onSelectChat）：
  // 消除「effect 何时跑」的不确定性，因果关系变得直白。

  return {
    messages,
    input,
    setInput,
    isBusy,
    isStreaming,
    status,
    error,
    sendMessage: (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      setInput('')
      void chat.sendMessage({ text: trimmed })
    },
    regenerate: () => {
      void chat.regenerate()
    },
    stop: () => {
      void chat.stop()
    },
    setMessages: chat.setMessages,
    reset: () => {
      chat.setMessages([])
    },
    respondToApproval: ({ id, approved, reason }) => {
      // 写入决定。若 sendAutomaticallyWhen 返回 true，SDK 会自动把消息发回服务端续流。
      void chat.addToolApprovalResponse({ id, approved, reason })
    },
  }
}
