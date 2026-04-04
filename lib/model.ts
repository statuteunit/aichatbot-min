//单一提供来源，使用同一的地址即可
export interface ChatModel {
    id: string
    name: string
    provider: string
    description: string
}

export const DEFAULT_CHAT_MODEL = 'Qwen2.5'

export const chatModels: ChatModel[] = [
    {
        id: 'llama3.2',
        name: 'llama3.2',
        provider: 'ollama',
        description: 'Meta 的开源模型，适合通用对话',
    },
    {
        id: 'qwen2.5:7b',
        name: 'qwen 2.5:7b',
        provider: 'ollama',
        description: '阿里云开源模型，中文能力强',
    },
    {
        id: 'deepseek-r1',
        name: 'DeepSeek R1',
        provider: 'ollama',
        description: '推理能力强，适合复杂任务',
    },
    {
        id: 'llava:7b',
        name: 'llava:7b',
        provider: 'ollama',
        description: '欧洲开源模型，性能优秀',
    },
]

export function getModelById(id: string): ChatModel {
    return chatModels.find(model => model.id === id) ?? chatModels[0]
}
