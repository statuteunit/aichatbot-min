// lib/chat/errorMessage.ts
//
// 把服务端流里带回来的错误码翻译成"用户看得懂、且知道下一步做什么"的一句话。
// 为什么单独成模块：纯函数，可单测穷举；措辞只应该有一份，散在组件里必然漂移。
//
// 注意：浏览器拿到的**不是**原始错误（AI SDK 默认统一成 "An error occurred."），
// 所以可读的原因必须由服务端 onError 决定（见 route.ts）。这里只做最后一步翻译。

export type ChatErrorCode =
  | 'RATE_LIMITED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'CONTEXT_TOO_LONG'
  | 'AUTH_FAILED'
  | 'UNKNOWN'

export interface FriendlyChatError {
  code: ChatErrorCode
  message: string
  /** 是否值得让用户点「重试」 */
  retryable: boolean
  /**
   * 服务端本次请求的 requestId。
   * 带上它，界面上的这次失败才能和服务端日志里的那条记录对上。
   * requestId 是每请求生成的 UUID，本来就会出现在 API 错误体里，不含敏感信息。
   */
  requestId?: string
}

const TABLE: Record<ChatErrorCode, Omit<FriendlyChatError, 'code'>> = {
  RATE_LIMITED: {
    message: '当前模型额度已用尽（OpenRouter 免费额度按天重置）。可以换一个模型，或稍后重试。',
    retryable: true,
  },
  UPSTREAM_UNAVAILABLE: {
    message: '连接模型服务失败（服务端已自动重试 3 次）。请稍后重试。',
    retryable: true,
  },
  CONTEXT_TOO_LONG: {
    message: '这次请求超出了模型上下文上限。请新建会话，或缩短输入。',
    retryable: false,
  },
  AUTH_FAILED: {
    message: '模型服务的凭据无效，请检查服务端的 OPENROUTER_API_KEY。',
    retryable: false,
  },
  UNKNOWN: { message: '生成失败，请重试。', retryable: true },
}

function isChatErrorCode(value: unknown): value is ChatErrorCode {
  return typeof value === 'string' && value in TABLE
}

/** 输入是服务端流里回传的 `{"code":"RATE_LIMITED"}`，也可能退化成纯文本 */
export function friendlyChatError(raw: string | undefined | null): FriendlyChatError {
  const text = (raw ?? '').trim()
  if (!text) return { code: 'UNKNOWN', ...TABLE.UNKNOWN }

  let payload: { code?: unknown; requestId?: unknown }
  try {
    payload = JSON.parse(text) as { code?: unknown; requestId?: unknown }
  } catch {
    // 不是 JSON：原样显示，方便看到"服务端到底说了什么"
    return { code: 'UNKNOWN', message: text, retryable: true }
  }

  const resolved = isChatErrorCode(payload.code) ? payload.code : 'UNKNOWN'
  const requestId =
    typeof payload.requestId === 'string' && payload.requestId.length > 0 ? payload.requestId : undefined
  return { code: resolved, ...TABLE[resolved], requestId }
}