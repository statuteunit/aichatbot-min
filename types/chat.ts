// 消息角色
export type Role='user'|'assistant'|'system';

// 单条消息
export interface Message{
    id:string;//对话标识符
    role:Role;//消息角色
    content:string;//消息内容
    createdAt:Date;//创建时间
}

// 发送到API的消息格式
export interface ChatCompletionMessage{
    role:Role;
    content:string;
}

// API请求体
export interface ChatRequest{
    messages:ChatCompletionMessage[];
    model?:string;
    stream?:boolean;
}

// SSE流式响应的单个数据块
export interface StreamChunk{
    id:string;
    choices:{
        //生成的结果数组
        delta:{
            //增量内容
            content?:string;
        },
        finish_reason?:string;//结束原因
    }[];
}
