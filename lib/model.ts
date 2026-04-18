//单一提供来源，使用同一的地址即可
export interface ChatModel {
    id: string
    name: string
    provider: string
    description: string
}

export const DEFAULT_CHAT_MODEL = 'openrouter/free'

export const chatModels: ChatModel[] = [
    {
        id: 'openrouter/free',
        name: 'openrouter/free',
        provider: 'openrouter',
        description: '自动匹配最优可用免费模型，适合复杂任务',
    },
    {
        id: 'moonshotai/kimi-k2.5:free',
        name: 'kimi-k2.5',
        provider: 'openrouter',
        description: '长文档阅读与代码生成能力极强',
    },
    {
        id: 'minimax/minimax-m2.5:free',
        name: 'Minimax M2.5',
        provider: 'openrouter',
        description: 'MoE稀疏架构,编程与工具调用顶尖',
    },
    {
        id: 'openai/gpt-oss-120b:free',
        name: 'gpt-oss-120b',
        provider: 'openrouter',
        description: 'OpenAI开源MoE大模型,表现优异',
    },
]

export function getModelById(id: string): ChatModel {
    return chatModels.find(model => model.id === id) ?? chatModels[0]
}
