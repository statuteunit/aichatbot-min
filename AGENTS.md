<!-- BEGIN:goal -->
一、项目目标
使用 Next.js App Router + NextAuth + Prisma/PostgreSQL + OpenRouter API 构建一个简化的 AI 对话平台，核心功能包括：

- OAuth 登录后的个人会话管理
- 多模型切换对话
- 基于 Fetch + ReadableStream 的自研 SSE 流式响应
- PostgreSQL 持久化会话与消息历史
- Artifacts 面板（当前支持代码块展示、复制与编辑）

二、技术栈（最小依赖）
{
  "dependencies": {
    "@auth/prisma-adapter": "^2.11.2",
    "@radix-ui/react-slot": "^1.2.4",
    "@vercel/postgres": "^0.10.0",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "next": "16.2.1",
    "next-auth": "5.0.0-beta.31",
    "react": "19.2.4",
    "react-dom": "19.2.4",
    "tailwind-merge": "^3.5.0",
    "zustand": "^5.0.12"
  },
  "devDependencies": {
    "@prisma/client": "^5.22.0",
    "prisma": "5",
    "typescript": "^5",
    "tailwindcss": "^4",
    "eslint": "^9",
    "eslint-config-next": "16.2.1"
  }
}

三、已实现的功能模块 
- Next.js 16 App Router
- React 19 + TypeScript
- Tailwind CSS 4 + 本地 shadcn 风格 UI 组件
- Prisma Client 连接 PostgreSQL
- NextAuth v5 + PrismaAdapter 实现 GitHub OAuth 登录
- middleware 保护需要登录的页面与接口

2. 模型选择系统
- `lib/model.ts` 定义模型配置（id、name、provider、description）
- 当前统一使用 OpenRouter 作为模型提供方
- 前端 `ModelSelector` 实现模型下拉选择
- 当前选中模型写入 Cookie：`selectedModel`
- 创建会话时保存当前模型，切换历史会话时恢复对应模型

3. 流式对话核心
- 前端使用自研 `hooks/useChat.ts`，改造为使用ai SDK的useChat，适配agent
- 基于 `fetch` + `ReadableStream.getReader()` 手动解析 SSE
- 兼容 OpenAI Chat Completions 风格的 `data:` 流式响应
- 支持发送、停止生成、重新生成、占位 assistant 消息更新
- 后端 `/api/chat` 调用 OpenRouter OpenAI 兼容接口
- 后端支持重试、用户中断处理、流式兜底响应与非流式兜底响应
- 当前未使用 Vercel AI SDK 的 `streamText`

4. 会话与消息持久化
- 使用 PostgreSQL + Prisma 替代内存 Map
- Prisma 模型包含 User、Account、Session、VerificationToken、Chat、Message
- `/api/chats` 支持获取会话列表与创建新会话
- `/api/chats/[id]` 支持查看、删除、修改会话标题
- `/api/chats/[id]/messages` 支持分页加载消息、写入用户/助手消息、更新助手流式结果
- 首条用户消息会自动生成会话标题
- Zustand `chat-cache-store` 缓存会话列表与最近消息快照

5. 前端聊天 UI
- `Chat` 组件负责会话状态、模型状态、历史加载和消息缓存协调
- `Siderbar` 提供会话历史、新建会话和会话切换
- `MessageList` 展示消息并支持向上滚动加载更早消息
- `MessageItem` 渲染用户/AI 消息，并识别 Markdown 代码块
- `ChatInput` 支持 Enter 发送、Shift+Enter 换行、生成中停止

6. Artifacts 面板
- 当前 Artifact 类型支持 `code` 与 `text`
- AI 消息中的 Markdown 代码块会渲染为 `CodeBlock`
- 代码块可打开到 `ArtifactPanel`
- Artifact 面板支持查看、复制、编辑、保存和关闭
- Artifact 状态由 Zustand `useArtifact` 管理
- 当前 Artifact 仅做前端状态管理，尚未持久化到数据库

四、简化策略总结
当前项目不再采用“内存/文件存储 + Vercel AI SDK streamText”的最小方案，而是采用：
- PostgreSQL + Prisma 持久化用户、会话与消息
- NextAuth v5 + GitHub OAuth 负责认证
- OpenRouter API Key + OpenAI 兼容接口负责模型调用
- 自己实现 `useChat` hook 和 SSE 流式处理
- Zustand 管理前端缓存与 Artifact 状态

五、实现顺序建议
第一步：完善认证与会话边界
- 移除前端残留的 MOCK_USER_ID 逻辑
- 创建会话时统一使用服务端 session.user.id
- 确保所有聊天接口只访问当前登录用户的数据

第二步：完善流式体验
- 为 `useChat` 增加更稳健的错误提示
- 优化停止生成后的消息状态
- 可选加入 requestAnimationFrame 批量刷新，降低流式高频 setState

第三步：完善模型选择
- 从 Cookie 初始化当前选中模型
- 统一前后端默认模型 ID
- 为模型配置补充 capabilities 字段，便于后续区分文本、代码、图片等能力

第四步：完善消息渲染
- 引入 Markdown 渲染与安全过滤
- 优化未闭合代码块的流式显示
- 支持更稳定的长消息滚动锚定

第五步：扩展 Artifacts
- 将 Artifact 从纯前端状态扩展为数据库持久化
- 支持文档类 Artifact
- 可选支持表格类 Artifact
- 支持从 AI 输出中自动创建 Artifact

六、环境变量
# .env.local
# .env
OPENROUTER_API_KEY=your-openrouter-api-key
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
POSTGRES_PRISMA_URL=your-postgres-prisma-url
AUTH_SECRET=your-auth-secret
AUTH_GITHUB_ID=your-github-oauth-client-id
AUTH_GITHUB_SECRET=your-github-oauth-client-secret

- 当前使用 OpenRouter API Key + OpenAI 兼容 API ✅
- 当前自研 `useChat` hook 和流式处理 ✅
- 当前使用 Prisma + PostgreSQL 持久化 ✅
- 当前使用 NextAuth v5 + GitHub OAuth 认证 ✅
<!-- END:goal -->

<!-- BEGIN:format -->
输出时请不要直接修改代码。请先告诉我解决这个问题的整体方案，再详细说明我需要如何一步步修改代码（包括改哪里、改什么、为什么改，以及给出每一步修改的代码块），我会自己动手修改。
<!-- END:format -->