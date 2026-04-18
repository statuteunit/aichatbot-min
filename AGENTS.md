<!-- BEGIN:goal -->
一、项目目标

使用 Next.js + Vercel AI SDK 构建一个简化的 AI 对话平台，核心功能包括：

- 多模型切换对话
- 流式响应
- Artifacts 面板（代码/文档/表格的展示与编辑）
二、技术栈（最小依赖）


{

"dependencies": {

"ai": "latest",

"@ai-sdk/openai": "latest",

"next": "latest",

"react": "latest",

"react-dom": "latest"

}

}

三、需要实现的功能模块 1. 基础架构

- Next.js 15 (App Router)
- 简单的内存/文件存储替代数据库
- next-auth实现OAuth认证 2. 模型选择系统
- 定义模型配置文件（id、name、provider、capabilities）
- 前端模型选择器 UI
- Cookie 存储当前选中模型
- 后端根据模型 ID 调用对应 AI 3. 流式对话核心
- 前端输入框 + 消息列表
- 后端 /api/chat 接口
- 使用 Vercel AI SDK 的 streamText 实现流式响应
- 消息历史管理（内存 Map） 4. Artifacts 面板（可选扩展）
- 代码/文档/表格的创建与展示
- 实时编辑功能
- 简化版本可先跳过
四、简化策略总结

PostgreSQL NextAuth 认证

五、实现顺序建议


第一步：环境搭建

- 初始化 Next.js 项目

- 安装 ai 和 @ai-sdk/openai

第二步：基础对话

- 创建输入框和消息列表 UI

- 实现 /api/chat 接口

- 配置 OpenAI API Key

- 实现流式响应

第三步：模型选择

- 创建模型配置文件

- 实现前端模型选择器

- 后端根据选择调用不同模型

第四步：消息持久化

- 使用postgres数据库

- 刷新页面可加载历史

第五步（可选）：Artifacts

- 添加代码/文档展示面板

- 实现编辑功能

六、环境变量


# .env.local

OPENAI_API_KEY=your-api-key

- 自己实现 useChat hook 和流式处理 ✅
- 使用 openrouter API_KEY + OpenAI 兼容 API
<!-- END:goal -->

<!-- BEGIN:summary -->
mini-chatbot
技术栈：Typescript+Nextjs+Zustand+Shadcn UI+Tailwind CSS +Prisma+postgreSQL
概述：全栈AI聊天应用，支持流式对话、联网搜索、图片生成、思考模式、语音交互、文件上传、会话管理、对话分享等功能
SSE流式传输与状态管理：
对 EventSource 无法携带 POST Body 与自义 Header 的限制，基于 Fetch + ReadableStream封装SSE解析层。
设计有限状态机管理消息生命周期(thinkingtool_callinganswering)，SSE事件驱动状态转换，解决多轮Function Calling场景下UI与流式消息状态不同步的问题。
渲染与性能优化
引入buffer 缓冲队列配合requestAnimationFrame批量刷新，解决流式 chunk 高频触发setState导致的冗余re-render，渲染频次从峰值120次/秒降至40次/秒以下。
针对流式输出时富文本块高度突变引发的布局偏移，组合预留骨架高度、overflow-anchor滚动锚定、未闭合Markdown块自动补全消除抖动。 
基于TanStackVirtual实现虚拟滚动，配合游标分页实现长会话场景下的流畅渲染。利用RSC将分享页Markdown渲染移至服务端，Page chunk压缩至5.6KB，TBT控制在90ms 以内。
认证与安全:设计弹窗 OAuth认证流程，通过 window.open+ postMessage实现跨窗口凭证传递，规避传统全页跳转造成的会话上下文丢失。用户凭证采用JWT+HttpOnly Cookie存储防止XSS窃取;针对AI输出可能包含恶意HTML的风险
配置rehype-sanitize白名单过滤，防止XSS注入。
<!-- END:summary -->
