'use client'

import { useState } from "react"
import { chatModels, ChatModel, getModelById } from "@/lib/model"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface ModelSelectorProps {
    selectedModelId: string;
    onModelChange: (modelId: string) => void;
}

// 模型选择器
export function ModelSelector({ selectedModelId, onModelChange }: ModelSelectorProps) {
    const [isOpen, setIsOpen] = useState(false)
    const selectedModel = getModelById(selectedModelId)

    return (
        <div className="relative mt-25">
            {/* 触发按钮 */}
            <Button
                variant="outline"
                size="sm"
                onClick={() => setIsOpen(!isOpen)}
                className="min-w-[140px] justify-between"
            >
                <span className="truncate">{selectedModel.name}</span>
                <span className="ml-2 text-xs opacity-50">▼</span>
            </Button>

            {/* 下拉菜单 */}
            {isOpen && (
                <>
                    {/* 遮罩层 */}
                    <div
                        className="fixed inset-0 z-10"
                        onClick={() => setIsOpen(false)}
                    />

                    {/* 菜单内容 */}
                    <div className="absolute top-full left-0 mt-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg z-20">
                        <div className="p-2">
                            <div className="text-xs text-gray-500 px-2 py-1">
                                选择模型
                            </div>
                            {chatModels.map((model) => (
                                <button
                                    key={model.id}
                                    onClick={() => {
                                        onModelChange(model.id);
                                        setIsOpen(false);
                                    }}
                                    className={cn(
                                        'w-full text-left px-3 py-2 rounded-md transition-colors',
                                        'hover:bg-gray-100',
                                        model.id === selectedModelId && 'bg-blue-50 text-blue-600'
                                    )}
                                >
                                    <div className="font-medium text-sm">{model.name}</div>
                                    <div className="text-xs text-gray-500">{model.description}</div>
                                </button>
                            ))}
                        </div>
                    </div>
                </>
            )}
        </div>
    )
}