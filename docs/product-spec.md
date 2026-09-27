# Product Spec — 需求 / 代码分析与受控编辑 Agent（代号：Inspector）

| 项 | 值 |
| --- | --- |
| 版本 | v0.2（草案） |
| 日期 | 2026-09-20 |
| 状态 | 待评审 |
| 适用范围 | `aichatbot-min`（Next.js 16 + NextAuth v5 + Prisma/PostgreSQL + OpenRouter） |
| 关联文档 | `AGENTS.md`、`CLAUDE.md` |

---

## 1. 背景与现状

### 1.1 当前项目是什么

`aichatbot-min` 目前是一个「简化的 AI 对话平台」：OAuth 登录 → 多模型切换 → SSE 流式对话 → PostgreSQL 持久化会话与消息 → 只读的 Artifacts 代码块面板。

技术上已经具备的关键基建：

- Next.js 16 App Router + React 19 + TypeScript + Tailwind 4 + Zustand
- NextAuth v5 + PrismaAdapter（GitHub OAuth，Google 已下线）
- PostgreSQL 持久化：`User / Account / Session / Chat / Message`
- `/api/chat` 透传 OpenRouter 的 OpenAI 兼容接口，含重试、中断、兜底
- 前端自研 `hooks/useChat.ts`，手写解析 SSE

### 1.2 尚未具备的能力

- 模型**无法调用任何外部能力**：`tools/` 目录里只有 `calculator`、`getCurrentTime` 两个纯计算工具，且 `app/api/chat/route.ts` 虽然已经 import 了 `streamText / stepCountIs / chatTools`，但请求处理主体仍是裸 `fetch` 透传，多步工具循环没有真正接上。
- 前端**丢弃工具调用事件**：`hooks/useChat.ts` 只解析 `choices[0].delta.content`，任何 `tool_calls` 增量都会被静默忽略。
- 数据模型**无法承载工具记录**：`Message` 只有 `role / content / createdAt`。

### 1.3 为什么要 Agent 化

对话平台的上限是「模型知道什么就回答什么」。用户真正的诉求是「让模型**去看我的代码**，然后告诉我该改什么」。这需要从「单轮生成」升级为「多步推理 + 工具调用 + 可追溯产出的 Agent」。

### 1.4 一句话定位

> 一个**提案优先、人工批准后受控编辑**的代码 Agent：它先阅读代码、收集证据、生成可审查 Diff；只有用户批准后，才在 Agent 专用工作区应用该 Diff 并执行受限验证。

---

## 2. 产品定位与边界

### 2.1 定义

Inspector 是嵌入现有聊天平台的**分析优先、受控编辑型 Agent**。用户提出需求或问题，Agent 先通过只读工具检索代码库，产出带证据的分析报告和可审查 Diff；用户明确批准后，Agent 仅在专用工作区应用已批准的 Diff，并运行固定白名单中的验证。

### 2.2 目标用户

| 角色 | 核心诉求 |
| --- | --- |
| 项目开发者（当前主要用户） | 加需求前想知道「会波及哪些文件」，改 bug 前想定位根因 |
| 代码评审者 | 拿到一份带 `file:line` 依据的变更影响面报告 |
| 新人 / 接手者 | 问「这个模块怎么工作的」，得到基于真实代码路径的解读 |

### 2.3 核心场景

1. **需求可行性分析** —— 「我想给聊天加多模型并行对比，需要动哪些地方？」
2. **影响面分析** —— 「把 `Message.content` 拆成结构化 parts，会波及哪些文件？」
3. **缺陷定位** —— 「流式响应中断后消息状态为什么偶尔丢？」
4. **代码理解** —— 「`useChat` 里 abort 之后的持久化路径是怎么走的？」
5. **变更提案** —— 「给出把工具调用接进前端的具体方案」→ 输出文本方案与可审查 Diff
6. **受控实现** —— 用户批准 Diff 后，将改动应用到 Agent 专用工作区，并返回验证结果与剩余风险

### 2.4 明确不做（Out of Scope）

> 这一节是产品的**硬边界**，不是「暂时不做」。

- ❌ **未经批准修改文件**：模型不得直接写文件；每次写入必须绑定已审查的 `proposalId`、`diffHash` 与审批记录
- ❌ **修改生产环境或用户主工作目录**：V1 只允许编辑 Agent 专用工作区，不得直接修改生产部署、原仓库 checkout 或任意外部路径
- ❌ **任意命令执行 / 安装依赖**：仅允许用户批准后执行服务端固定白名单中的 `lint`、`typecheck`、`test` 等验证任务
- ❌ **删除、重命名、批量覆盖文件**：V1 不提供此类工具；新增文件与修改已有文件必须通过 patch 提案
- ❌ **访问数据库或线上环境**（不跑 migration、不查生产数据）
- ❌ **读取密钥与凭据**（`.env*`、`AUTH_SECRET`、`OPENROUTER_API_KEY` 等一律屏蔽）
- ❌ **Git 提交、推送、创建 PR、部署**
- ❌ **泛化通用助手**：不承接「写一篇文章」「画个图」等与代码/需求无关的任务
- ❌ 多租户 / 团队协作 / 权限体系（本期不做）

### 2.5 受控编辑承诺（Controlled-Edit Guarantee）

> **Inspector 默认只读。它只能在用户明确批准一份未过期、未冲突的 Diff 后，编辑其专用工作区；不得直接修改生产代码或执行不可逆操作。**

这条承诺必须**由架构保证，而不是由提示词保证**。提示词负责解释边界；工具注册、工作区隔离、审批令牌和基线 hash 校验负责实际约束。详见第 3 章。

---

## 3. 安全模型：为什么「可编辑」仍必须受架构约束

LLM 会越狱、会误解、会在长上下文里忘记指令。因此「批准后才能编辑」不能只写在 system prompt 里 —— 那只是**礼貌请求**。Inspector 用工具能力、工作区隔离、审批与审计三层护栏把编辑权限变成可验证的事实。

### 3.1 三层护栏

#### L1 — 工具层：能力分级，写入只能应用已批准提案

Agent 只能调用 `tools/index.ts` 里注册的工具。工具按权限分级：

| 级别 | 工具 | 执行规则 |
| --- | --- | --- |
| P0 读取 | `listDir`、`readFile`、`grep`、`gitLog`、`gitDiff` | 自动执行；仍经过路径、大小与敏感文件校验 |
| P1 提案 | `createPatchProposal` | 自动执行；只保存 Diff 与文件基线 hash，绝不写入工作区 |
| P2 编辑 | `applyApprovedPatch` | 必须人工批准；只接受已保存的提案 ID，禁止传入任意内容或路径 |
| P3 验证 | `runApprovedValidation` | 必须人工批准；只接受预定义的任务 ID，不接受任意 shell 字符串 |

- 禁止实现通用 `writeFile({ path, content })`、`runCommand({ command })`、`installPackage`、`gitCommit`、`gitPush` 等工具
- `applyApprovedPatch` 必须校验：提案状态为 `approved`、审批人属于当前会话、`diffHash` 未变、目标文件基线 hash 未变
- 现有 `calculatorTool`、`getCurrentTimeTool` 保留（无副作用）
- 新增工具必须在注册表中声明权限级别、输入 Schema、输出上限、超时、是否需要审批与审计字段

> **关键点**：模型生成的是提案，不是写入权。写入能力只接受服务端保存且用户批准的提案。

#### L2 — 工作区与执行层：只编辑专用副本，不允许任意命令

每个 Agent run 使用独立 `workspaceId`。工作区从授权仓库快照或 Git worktree 创建，不复用生产部署或用户正在编辑的原始 checkout。所有文件访问与验证任务必须满足：

| 约束 | 实现方式 |
| --- | --- |
| 路径白名单 | `realpath` 解析后必须落在当前 `workspaceId` 根目录，拒绝 `..`、绝对路径、空字节与符号链接逃逸 |
| 敏感文件屏蔽 | `.env`、`.env.*`、`*.pem`、`*.key`、`.git/config`、`node_modules/**` 一律拒绝 |
| 编辑方式 | 仅通过统一 diff 原子应用；写入前再次校验文件基线 hash；不支持删除和重命名 |
| 验证白名单 | 将 `lint`、`typecheck`、`test` 映射到服务端固定 argv；模型不能提供命令字符串、环境变量或工作目录 |
| 不走 shell | 以 **argv 数组** 启动固定任务，禁止拼接字符串走 shell，杜绝 `;`、`&&`、`|`、`` ` ``、`$()` 注入 |
| 超时与输出上限 | 单次验证超时 60s，stdout/stderr 截断 200KB；超时即终止并记录结果 |
| 回滚 | 保存应用前的文件 hash 与反向 diff；仅允许用户批准后回滚同一提案 |

#### L3 — 运行层：没有凭据，就没有破坏力

- Agent 工作区不注入数据库、部署、Git 写入或云平台凭据；模型服务密钥仅保存在 API 进程中，不写入工作区
- 若接 Git 仓库，使用只读 Deploy Key / Token 获取基线；Agent 不持有 push 权限
- 分析和编辑用的工作区放在临时目录或受控 worktree；run 结束后按保留策略清理
- 出站网络仅允许模型 API，禁止任意外联（防止把代码外传）

### 3.2 Diff 审查与审批绑定

编辑生命周期必须固定为：

```text
inspect → createPatchProposal → reviewDiff → approve/reject →
applyApprovedPatch → approve/reject validation → runApprovedValidation → report
```

- 每份提案必须保存 `proposalId`、`workspaceId`、统一 diff、`diffHash`、涉及文件、每个文件的基线 hash、创建人和过期时间。
- UI 必须展示文件树、逐文件 Diff、风险说明、测试建议；批准前工作区文件不得变化。
- 审批只对该提案有效；拒绝、过期、用户切换工作区或基线 hash 不匹配时，提案必须变为 `rejected` 或 `stale`。
- 应用成功不是交付终点：Agent 必须展示实际变更、验证结果、未执行验证和剩余风险。

### 3.3 审计与可追溯

- 每次分析产出必须携带**证据链**：所有结论标注 `文件路径:行号`
- 记录完整工具调用轨迹（调了什么工具、参数摘要、结果摘要、耗时、审批 ID、批准人和执行结果），可回放
- 记录 Diff、diff hash、文件基线 hash、应用时间、验证任务、退出码和回滚记录
- 无证据的结论必须显式标注「推测」，不得伪装成事实

### 3.4 越界与失败处理

| 情况 | 处理 |
| --- | --- |
| 模型请求不存在或禁止的工具 | 工具层直接返回 `TOOL_NOT_AVAILABLE` / `TOOL_FORBIDDEN`，并记录审计日志 |
| 工具参数越出路径白名单 | 拒绝执行，返回 `PATH_DENIED`，记录审计日志 |
| 用户要求修改文件 | 先生成 Diff；未批准前固定进入 `awaiting_approval`，不得写入 |
| 用户批准后文件已变化 | 拒绝应用，标记 `STALE_PROPOSAL`，要求重新检索并生成新提案 |
| 用户拒绝审批 | 持久化拒绝原因；提示模型不重试同一工具调用 |
| 验证任务失败或超时 | 保留已应用 Diff，报告失败日志摘要；不自动反复重试或回滚 |
| 代码源不可用（clone 失败/权限不足） | 明确报错，降级到「粘贴代码片段」模式，不静默编造 |

---

## 4. 核心能力

| 编号 | 能力 | 说明 | 依赖工具 |
| --- | --- | --- | --- |
| C1 | **需求澄清** | 需求模糊时主动追问（改哪个模块？兼容旧数据吗？），最多 N 轮，避免无效分析 | 无 |
| C2 | **代码库理解** | 目录结构、模块职责、依赖关系；基于真实文件而非猜测 | `listDir` `readFile` `grep` `gitLog` |
| C3 | **影响面分析** | 一个改动会波及哪些文件/接口/数据模型，给出调用链 | `grep` `readFile` `listDir` |
| C4 | **缺陷与风险识别** | 定位可疑逻辑、边界条件、状态竞争；区分「已确认」与「可疑」 | `readFile` `grep` |
| C5 | **方案设计** | 输出多方案对比（改动量 / 风险 / 兼容性），并给出推荐 | 上述全部 |
| C6 | **变更提案** | 生成带文件基线 hash 的 unified diff、风险说明和验证计划；此阶段不写盘 | `createPatchProposal` |
| C7 | **受控应用** | 用户批准后，将已保存提案原子应用到 Agent 专用工作区 | `applyApprovedPatch` |
| C8 | **受控验证** | 用户批准后运行固定 `lint/typecheck/test` 任务，返回截断日志与退出码 | `runApprovedValidation` |
| C9 | **产出归档** | 报告、Diff、审批、工具与验证记录落库，可回放、可回滚 | 无 |

---

## 5. 工具清单（Tool Contract）

> P0/P1 工具可自动执行；P2/P3 工具必须经人工审批。所有工具均须具备 Schema 校验、路径或任务白名单、超时、输出截断和审计记录。

| 工具名 | 输入 | 输出 | 约束 |
| --- | --- | --- | --- |
| `listDir` | `path`, `depth?` | 目录树（忽略 `node_modules/.next/.git`） | 路径白名单；默认深度 ≤3 |
| `readFile` | `path`, `startLine?`, `endLine?` | 文件内容 + 总行数 | 单文件 ≤200KB；命中敏感文件直接拒绝 |
| `grep` | `pattern`, `glob?`, `maxResults?` | 匹配行 + `file:line` | 底层用 ripgrep；默认上限 200 条 |
| `gitLog` | `limit?`, `path?` | 提交摘要（hash/作者/日期/标题） | 只读子命令 |
| `gitDiff` | `base?`, `target?`, `path?` | diff 文本 | 只读子命令；输出截断 |
| `listSymbols` | `path` | 导出的函数/类/类型清单 | 基于轻量正则/AST，非完整语义分析 |
| `askUser` | `question`, `options?` | 用户选择 | 用于 C1 需求澄清，产生中断等待 |
| `createPatchProposal` | `diff`, `files`, `summary`, `validationPlan` | `proposalId`、`diffHash`、预览元数据 | P1；保存提案，不写工作区；diff 必须通过格式、路径和敏感文件校验 |
| `applyApprovedPatch` | `proposalId` | 实际变更文件、应用结果 | P2；需审批；仅应用已批准、未过期且基线 hash 一致的提案 |
| `runApprovedValidation` | `proposalId`, `taskId` | 退出码、截断日志、耗时 | P3；需审批；`taskId` 仅限 `lint/typecheck/test` 等注册任务 |

**已存在并保留**：`calculator`、`getCurrentTime`（无副作用，用于演示与基础计算）。

**明确不实现**：通用 `writeFile`、通用 `editFile`、任意 `runCommand`、`installPackage`、`deleteFile`、`renameFile`、`gitCommit`、`gitPush`、数据库迁移、部署。

---

## 6. 交互流程

### 6.1 会话状态机

```
idle
  └─(用户提出需求)─> analyzing
        ├─(需要澄清)─> awaiting_user ─(用户回答)─> analyzing
        ├─(调用只读工具)─> tool_running ─> analyzing
        ├─(生成 Diff)─> proposal_ready ─(用户审批)─> applying ─> validating ─> completed
        │                    └─(拒绝 / 过期 / 文件冲突)─> rejected_or_stale ─> analyzing
        ├─(调用需审批工具)─> awaiting_approval ─(批准)─> tool_running
        │                                        └─(拒绝)─> analyzing
        ├─(用户点击停止)─> cancelled ─> idle
        └─(生成完毕)─> completed ─> idle
```

### 6.2 典型时序（需求影响面分析）

```
用户: 把 Message.content 改成结构化 parts，会影响哪些地方？
Agent: [askUser] 「是否需要兼容已有历史消息？」        ← 澄清，可选
用户: 需要兼容
Agent: [grep "Message.content"] → 命中 4 处
Agent: [readFile hooks/useChat.ts]
Agent: [readFile app/api/chats/[id]/messages/route.ts]
Agent: [readFile lib/repositories/chatRepository.ts]
Agent: [gitLog limit=10 path=prisma/]
Agent: [createPatchProposal] → `proposalId=p_123`，生成 Diff、文件基线 hash 与测试计划
UI: 展示文件树与逐文件 Diff，状态 `awaiting_approval`
用户: 批准提案
Agent: [applyApprovedPatch proposalId=p_123] → 仅编辑该 run 的专用工作区
UI: 展示实际改动与二次确认的验证任务
用户: 批准 `typecheck`
Agent: [runApprovedValidation taskId=typecheck] → 返回退出码、日志摘要与耗时
系统: 报告、Diff、审批、工具和验证记录落库
```

### 6.3 澄清策略

- 仅当**缺失关键信息会导致分析方向错误**时才追问，最多 2 轮
- 问题以选项形式给出（复用 `askUser` 工具）
- 用户表示「你看着办」时，采用最保守假设并**在报告中显式声明假设**

---

## 7. 输出规范（Output Contract）

### 7.1 分析报告结构

```markdown
# <标题>
## 结论摘要            ← 3 句话内，先给答案
## 现状分析            ← 带 file:line 证据
## 影响面              ← 文件清单 + 波及链路
## 方案对比            ← 至少 2 个方案（改动量/风险/兼容性）
## 推荐方案与步骤        ← 每步：改哪里 / 改什么 / 为什么
## 风险与假设
## 待确认问题
```

### 7.2 变更提案格式

必须可供人工审查，也可在用户批准后由 Agent 应用到专用工作区：

````markdown
### 步骤 1：修改 `hooks/useChat.ts`
**位置**：`hooks/useChat.ts:150`
**原因**：当前只解析 `delta.content`，工具调用事件被丢弃
**改法**：
```ts
// 修改前
const content = parsed.choices?.[0]?.delta?.content
// 修改后
...具体代码...
```
````

### 7.3 证据规范

- 每一个事实性结论**必须**带 `文件路径:行号`
- 无法定位证据的，标注 `⚠️ 推测（未找到直接证据）`
- 禁止编造不存在的文件路径与 API

### 7.4 Diff 与审批规范

- Diff 必须是 unified diff，并列出每个改动文件的 `path`、基线 hash、变动摘要和风险。
- 新增文件和修改文件必须明确区分；V1 不允许删除或重命名文件。
- `proposalId`、`diffHash`、`workspaceId`、审批人和过期时间必须持久化；任何字段变化都会使审批失效。
- 用户批准前禁止写入；批准后仍须在应用前再次检查文件基线 hash。
- 验证计划必须使用注册 `taskId`，不得输出或执行任意 shell 命令。

### 7.5 不确定性表达

| 置信度 | 表达 |
| --- | --- |
| 已确认 | 「`useChat.ts:150` 只读取 delta.content」 |
| 高度可能 | 「推测此处是主要瓶颈，依据：…」 |
| 未知 | 「未找到相关实现，可能需要确认 X」 |

---

## 8. 数据模型变更（Prisma）

```prisma
// 会话增加模式标记，区分「普通对话 / 只读分析 / 受控编辑 Agent」
model Chat {
  mode      String   @default("chat")   // "chat" | "inspector" | "coding"
  agentRuns AgentRun[]
  // ...existing fields
}

// 消息增加结构化内容与工具轨迹
model Message {
  parts     Json?                        // 结构化内容块（文本/工具调用/审批/Diff/报告）
  reasoning String?                      // 可选：推理摘要
  toolCalls ToolCallRecord[]
  // ...existing fields
}

// 每次 Agent 运行拥有独立工作区和完整审计。
model AgentRun {
  id          String   @id @default(uuid())
  chatId      String
  userId      String
  workspaceId String
  status      String   // planning | inspecting | awaiting_approval | applying | validating | done | failed | cancelled
  traceId     String
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  chat      Chat              @relation(fields: [chatId], references: [id], onDelete: Cascade)
  proposals PatchProposal[]
  toolCalls ToolCallRecord[]

  @@index([chatId, createdAt])
  @@index([userId, createdAt])
}

// 提案在批准前仅保存 Diff；基线 hash 让过期或冲突的提案无法被应用。
model PatchProposal {
  id             String   @id @default(uuid())
  runId          String
  workspaceId    String
  diff           String
  diffHash       String
  summary        String
  baseFileHashes Json
  status         String   // draft | approved | rejected | stale | applied | failed | reverted
  expiresAt      DateTime
  approvedBy     String?
  approvedAt     DateTime?
  appliedAt      DateTime?
  createdAt      DateTime @default(now())

  run AgentRun @relation(fields: [runId], references: [id], onDelete: Cascade)

  @@index([runId, status])
}

// 所有工具均留痕；写入与验证必须关联 run，必要时关联触发它的消息。
model ToolCallRecord {
  id         String   @id @default(uuid())
  runId      String
  messageId  String?
  toolName   String
  input      Json
  output     String?
  status     String                      // ok | awaiting_approval | denied | error
  approvalId String?
  durationMs Int?
  createdAt  DateTime @default(now())

  run     AgentRun @relation(fields: [runId], references: [id], onDelete: Cascade)
  message Message?  @relation(fields: [messageId], references: [id], onDelete: SetNull)

  @@index([runId, createdAt])
  @@index([messageId])
}
```

**兼容性**：`Chat.mode` 带默认值；`parts`、`reasoning`、`messageId` 均为 nullable，历史会话与消息不受影响。数据库迁移在 V1 禁止由 Agent 执行，应由开发者审核后手动执行。

---

## 9. 接口设计

| 接口 | 变更 |
| --- | --- |
| `POST /api/chat` | 接入 `streamText` + `stepCountIs(N)`；按 `chat.mode` 注册只读或受控编辑工具，并返回 UI Message Stream |
| `GET /api/chats/[id]/messages` | 返回体增加 `parts` / `toolCalls` |
| `POST /api/chats/[id]/messages` | 持久化工具调用记录 |
| `PATCH /api/chats/[id]/messages` | 流式结束后写入最终 `parts`（含工具轨迹） |
| `POST /api/agent/runs`（新增） | 创建绑定当前用户、聊天与专用工作区的 Agent run |
| `GET /api/agent/runs/[id]`（新增） | 获取 run、工具时间线、提案与验证状态；必须校验会话所有权 |
| `POST /api/agent/runs/[id]/approvals/[approvalId]`（新增） | 保存批准或拒绝；批准必须绑定当前用户、`proposalId`、`diffHash` 和 `workspaceId` |
| `GET /api/agent/proposals/[id]`（新增） | 返回经脱敏后的 Diff 预览与风险摘要 |
| `POST /api/agent/proposals/[id]/apply`（新增） | 仅应用已批准、未过期、基线 hash 一致的提案；必须幂等 |
| `POST /api/agent/proposals/[id]/validate`（新增） | 执行批准后的固定验证任务；禁止传入原始 command |
| `GET /api/tools`（新增，可选） | 返回工具名称、权限等级、审批要求与可用状态；不暴露执行实现 |

---

## 10. 前端改造点

| 文件 | 改动 |
| --- | --- |
| `hooks/useChat.ts` | **核心阻塞点**。当前只读 `delta.content`；改用 AI SDK UI Message Stream 或等价协议，保留 text/tool/approval/Diff/错误 parts |
| `types/chat.ts` | `Message` 增加 `parts?` / `toolCalls?`；新增 `AgentRun`、`PatchProposal`、`Approval`、`ValidationResult` 类型 |
| `components/messageItem.tsx` | 渲染工具过程、审批请求与结果，禁止展示模型原始推理 |
| `components/chat.tsx` | 支持 `chat / inspector / coding` 模式；Coding 模式显示“提案优先、批准后编辑工作区”徽标 |
| `components/diffReviewPanel.tsx`（新增） | 展示文件树、统一 Diff、风险、基线状态、批准/拒绝与回滚入口 |
| `components/approvalCard.tsx`（新增） | 展示操作摘要、影响文件、批准与拒绝；提交后不可篡改审批对象 |
| `components/validationPanel.tsx`（新增） | 展示固定验证任务、批准状态、耗时、退出码与截断日志 |
| `stores/useArtifact.ts` | 增加 `report`、`diff` 类型识别；Artifact 保存预览数据而非执行权限 |
| `types/artifact.ts` | `Artifact.kind` 增加 `'report' | 'diff'` |
| `lib/model.ts` | `ChatModel` 增加 `capabilities`，标记是否支持工具调用（与 AGENTS.md 第三步规划一致） |
| `tools/index.ts` | 注册 P0/P1/P2/P3 工具与权限元数据；禁止通用写入、任意命令、提交、推送和部署工具 |

---

## 11. 非功能性需求

| 维度 | 要求 |
| --- | --- |
| **上下文预算** | 禁止把整个仓库塞进上下文。必须先 `listDir` 建图 → `grep` 定位 → `readFile` 精读，单次分析读取文件数 ≤ 30 |
| **检索策略** | 优先 `grep` 定位再精读；`readFile` 支持行号区间，避免整文件读取 |
| **流式体验** | 工具调用过程实时可见（「正在读取 X」），不允许长时间无输出 |
| **可中断** | 复用现有 `stop`（AbortController）机制，中断后保留已生成内容 |
| **单次分析时长** | 目标 ≤ 90s；超过 3 分钟应提示用户缩小问题范围 |
| **工具步数上限** | `stepCountIs(8)`，防止无限循环 |
| **成本** | 单次分析 token 预算上限可配置，超限终止并产出阶段性结论 |
| **编辑时限** | 提案默认 30 分钟过期；审批后、应用前再次检查目标文件基线 hash |
| **编辑范围** | 单份提案最多 10 个文件、总 diff 最多 500KB；超限需拆分提案并分别审批 |
| **验证限制** | 仅允许注册的 `lint/typecheck/test` 任务；最大 60s；不得访问数据库、网络或环境变量 |
| **审计** | 所有工具、Diff、审批、应用、验证和回滚均落库，可按 run 回放 |
| **幂等性** | 同一批准请求和应用请求使用幂等键；重复点击不得重复写入或重复运行验证 |

---

## 12. 里程碑

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **M0 骨架** | 打通 `streamText` 多步工具循环；前端能显示工具调用过程 | 问「当前项目用了哪些模型」能触发 `grep` 并正确回答 |
| **M1 只读工具** | 实现 `listDir / readFile / grep / gitLog` 并注册 | 能基于真实文件回答「useChat 的持久化路径」 |
| **M2 护栏** | 路径白名单 + 敏感文件屏蔽 + 审计落库 + 权限徽标 | 越界请求被拒绝并留痕 |
| **M3 分析产出** | 报告结构模板 + `file:line` 证据规范 + Artifact 落库 | 产出符合第 7 章格式的报告 |
| **M4 需求澄清** | `askUser` 工具 + 澄清策略 | 模糊需求能先追问再分析 |
| **M5 打磨** | 上下文预算、步数上限、成本控制、错误话术 | 单次分析 ≤90s，无越权 |
| **M6 Diff 提案** | `PatchProposal`、文件基线 hash、Diff 预览、审批卡片 | 批准前工作区文件 hash 不变；用户可逐文件审查 Diff |
| **M7 受控编辑** | 专用工作区、`applyApprovedPatch`、冲突与过期检测、反向 diff | 仅批准的提案能落盘；文件变化后旧提案被拒绝；无未批准写入 |
| **M8 受控验证** | 固定验证任务、超时/输出截断、验证审批和报告 | Agent 只能运行注册任务；报告含退出码和日志摘要 |
| **M9 可恢复性** | 应用与回滚审计、幂等键、失败恢复 | 同一提案不会被重复应用；批准后可回滚同一提案 |

---

## 13. 度量指标

- **有用率**：报告被用户采纳/复制执行的比例
- **证据准确率**：`file:line` 定位正确的比例（目标 ≥95%）
- **未批准写入次数**：**必须恒为 0**（任意一次为 P0 事故）
- **错误应用率**：已批准但因文件冲突、hash 不匹配或范围越界而被阻止的比例；目标是阻止率 100%
- **Diff 可采纳率**：用户批准并保留的提案比例
- **验证成功率**：应用后批准的验证任务通过比例；单独记录失败原因
- **平均分析时长**、**平均工具调用步数**
- **审批等待时长**、**编辑/验证耗时**、**回滚次数**
- **澄清轮次均值**（过高说明需求理解差，过低说明该问没问）

---

## 14. 开放问题（待决策）

| # | 问题 | 备选 | 倾向 |
| --- | --- | --- | --- |
| Q1 | 代码源与编辑工作区如何接入？ | A. 每次 run 创建临时 Git worktree<br>B. 直接编辑用户当前 checkout<br>C. MCP 本地工作区 | **MVP 选 A**：专用 worktree，禁止直接编辑当前 checkout；B 永不采用 |
| Q2 | 是否提供命令工具？ | A. 不提供<br>B. 固定验证任务映射到 argv<br>C. 模型任意命令 | **选 B**：仅 `lint/typecheck/test` 等注册任务，均需审批；C 永不采用 |
| Q3 | 修改粒度？ | A. 统一 Diff + 文件基线 hash<br>B. 通用 `writeFile` | **选 A**：可审查、可检测冲突、可回滚；B 永不采用 |
| Q4 | 是否允许删除、重命名、迁移？ | A. V1 禁止<br>B. 与修改文件一同开放 | **选 A**：先验证受控修改链路，再单独评估高风险操作 |
| Q5 | 入口设计？ | A. 复用聊天，使用 `mode` 区分<br>B. 独立页面 | **选 A**：复用会话和历史；Coding 模式必须有显著权限标识 |
| Q6 | 多仓库支持？ | 单仓库 / 多仓库 | V1 单仓库，每个 run 显示并锁定 `workspaceId` |

---

## 15. 术语表

| 术语 | 含义 |
| --- | --- |
| **受控编辑护栏** | 由工具能力、工作区隔离、Diff 审批、基线 hash 与审计共同保证的编辑边界 |
| **变更提案（Patch Proposal）** | 含 unified diff、风险、文件基线 hash 和验证计划的待审批对象；批准前不写盘 |
| **专用工作区（Workspace）** | 与用户原 checkout、生产部署隔离的临时 Git worktree 或受控副本 |
| **基线 hash** | 创建提案时记录的目标文件内容 hash；应用前不匹配即视为提案过期或冲突 |
| **审批绑定** | 对 `proposalId + diffHash + workspaceId` 的显式用户决定；不能复用到其他提案或工作区 |
| **证据链** | 每个结论对应的 `文件路径:行号` 引用 |
| **P0/P1 工具** | 可自动执行的读取或提案工具；不得修改工作区 |
| **P2/P3 工具** | 必须人工审批的编辑或验证工具；其输入与结果必须落审计 |
