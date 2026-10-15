// 全局缓存，管理所有chats
import { create } from 'zustand'
import type { UIMessage } from 'ai'

// 单个chat摘要
export interface ChatSummary {
  id: string
  title: string
  model: string
  /** 会话模式：chat | inspector | coding。历史数据可能缺失，读的时候要给默认值 */
  mode?: string
  updatedAt: string
}

export interface MessageCursor {
  beforeId: string
  beforeCreatedAt: string
}

// 消息缓存
// 存 UIMessage 而不是自定义 Message：切到 @ai-sdk/react 的 useChat 后，
// 缓存的唯一消费方就是 useChat 的 setMessages，形状必须一致，否则要来回转换。
export interface ChatMessageCache {
  recentMessages: UIMessage[]
  hasMore: boolean
  nextCursor: MessageCursor | null
  loadedAt: number
}

// chats仓库类型
interface ChatCacheState {
  chats: ChatSummary[]
  chatsLoaded: boolean
  messageCache: Record<string, ChatMessageCache>

  /**
   * 当前打开的会话 id。
   *
   * 为什么放在 store 而不是只留在组件 state：
   * 任何一次热更新（被改的往往正是 components/chat.tsx）都会让 React 的 state
   * 归零，而模块级的 store 不会。少了它，重挂载后 currentChatId 变成 null，
   * 界面显示成"新会话"，缓存里明明有消息却是一片空白，只能靠点一次侧边栏救回来。
   */
  activeChatId: string | null
  setActiveChatId: (chatId: string | null) => void

  setChats: (chats: ChatSummary[]) => void
  upsertChat: (chat: ChatSummary) => void
  removeChat: (chatId: string) => void
  invalidateChats: () => void

  setChatSnapshot: (
    chatId: string,
    visibleMessages: UIMessage[],
    hasMore: boolean,
    nextCursor: MessageCursor | null,
  ) => void

  clearChatSnapshot: (chatId: string) => void
}

export const useChatCacheStore = create<ChatCacheState>((set) => ({
  chats: [],
  chatsLoaded: false,
  messageCache: {},
  activeChatId: null,
  setActiveChatId: (chatId) => set({ activeChatId: chatId }),
  setChats: (chats) =>
    set({
      chats: Array.isArray(chats) ? chats : [],
      chatsLoaded: true,
    }),
  // 更新或传入chat
  upsertChat: (chat) =>
    set((state) => {
      const exists = state.chats.some((item) => item.id === chat.id)
      const chats = exists ? state.chats.map((item) => item.id === chat.id ? chat : item) : [chat, ...state.chats]
      return { chats }
    }),
  removeChat: (chatId) =>
    set((state) => ({
      chats: state.chats.filter((item) => item.id !== chatId)
    })),
  // 重新获取
  invalidateChats: () =>
    set({
      chatsLoaded: false
    }),
  setChatSnapshot: (chatId, visibleMessages, hasMore, nextCursor) =>
    set((state) => ({
      messageCache: {
        ...state.messageCache,
        [chatId]: {
          recentMessages: visibleMessages,
          hasMore,
          nextCursor,
          loadedAt: Date.now()
        },
      },
    })),
  clearChatSnapshot: (chatId) =>
    set((state) => {
      const next = { ...state.messageCache }
      delete next[chatId]
      return { messageCache: next }
    })
}))