//单一提供来源，使用同一的地址即可
export interface ChatModel {
    id: string
    name: string
    provider: string
    description: string
}

export const DEFAULT_CHAT_MODEL = 'deepseek-r1:free'

export const chatModels: ChatModel[] = [
    {
        id: 'qwen/qwen2.5-72b-instruct:free',
        name: 'qwen 2.5',
        provider: 'openrouter',
        description: '阿里云开源模型，中文能力强',
    },
    {
        id: 'anthropic/claude-3-haiku:free',
        name: 'claude-3-haiku',
        provider: 'openrouter',
        description: 'Anthropic 的轻量模型，适合编写代码',
    },
    {
        id: 'deepseek/deepseek-r1:free',
        name: 'DeepSeek R1',
        provider: 'openrouter',
        description: '推理能力强，适合复杂任务',
    },
    {
        id: 'openai/gpt-3.5-turbo:free ',
        name: 'chatgpt3.5',
        provider: 'openrouter',
        description: 'OpenAI gpt模型,性能优秀',
    },
]

export function getModelById(id: string): ChatModel {
    return chatModels.find(model => model.id === id) ?? chatModels[0]
}
