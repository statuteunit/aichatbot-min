import type { MessageStatus, ToolTrace } from './stream'

// 消息角色
export type Role = 'user' | 'assistant' | 'system';

// 单条消息
export interface Message {
    id: string;//对话标识符
    role: Role;//消息角色
    content: string;//消息内容
    createdAt: Date;//创建时间
    /** 展示状态；历史消息从数据库读出来时一律为 'done' */
    status?: MessageStatus
    /** 工具轨迹 */
    tools?: ToolTrace[]
    /** 错误信息，仅 status='error' 时有值 */
    errorText?: string
}

// 发送到API的消息格式
export interface ChatCompletionMessage {
    role: Role;
    content: string;
}

// API请求体
export interface ChatRequest {
    messages: ChatCompletionMessage[];
    model?: string;
    stream?: boolean;
}

// SSE流式响应的单个数据块
export interface StreamChunk {
    id: string;
    choices: {
        //生成的结果数组
        delta: {
            //增量内容
            content?: string;
        },
        finish_reason?: string;//结束原因
    }[];
}
