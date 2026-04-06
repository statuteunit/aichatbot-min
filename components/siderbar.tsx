'use client'

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface siderbarProps {
  isOpen: boolean
  onClose: () => void
  onNewChat: () => void
  onSelectChat: (chatId: string) => void
  currentChatId: string | null
}

export function Siderbar({ isOpen, onClose, onNewChat, onSelectChat, currentChatId }: siderbarProps) {
  const [chats, setChats] = useState([])
  // 获取对话列表
  const loadChats = async () => {
    try {
      const response = await fetch('/api/chats')
      if (!response.ok) return
      const data = await response.json()
      setChats(data)
    } catch (e) {
    }
  }

  // 组件挂在时加载对话记录
  useEffect(() => {
    loadChats()
  }, [])

  // 打开对话列表时重新请求对话列表
  useEffect(() => {
    if (isOpen) {
      loadChats()
    }
  }, [isOpen])

  return (
    <>
      {/* 遮罩层 */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40"
          onClick={onClose}
        />
      )}

      {/* 侧边栏 */}
      <div
        className={cn(
          'fixed left-0 top-0 h-full w-64 bg-white border-r z-50 transition-transform duration-300',
          isOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {/* 头部 */}
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="font-bold">对话历史</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
            ✕
          </button>
        </div>

        {/* 新建按钮 */}
        <div className="p-4">
          <Button
            onClick={onNewChat}
            className="w-full"
            variant="outline"
          >
            + 新建对话
          </Button>
        </div>

        {/* 对话列表 */}
        <div className="overflow-y-auto h-[calc(100%-120px)]">
          {chats.length === 0 ? (
            <div className="p-4 text-center text-gray-400">
              暂无对话
            </div>
          ) : (
            chats.map((chat: any) => (
              <button
                key={chat.id}
                onClick={() => onSelectChat(chat.id)}
                className={cn(
                  'w-full text-left px-4 py-3 hover:bg-gray-100 transition-colors',
                  chat.id === currentChatId && 'bg-blue-50 border-l-2 border-blue-500'
                )}
              >
                <div className="font-medium text-sm truncate">{chat.title}</div>
                <div className="text-xs text-gray-400 mt-1">
                  {new Date(chat.updatedAt).toLocaleDateString()}
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </>
  )
}