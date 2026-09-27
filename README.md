# 最终架构
用户需求
  ↓
Planner：拆解任务、列出影响文件
  ↓
Inspector：只读检索、收集 file:line 证据
  ↓
Patch Generator：生成 unified diff 与测试计划
  ↓
用户审查 Diff
  ↓ 批准（绑定 proposalId + 文件基线 hash）
Patch Executor：仅在受控工作区原子应用 patch
  ↓
Validator：仅运行命令白名单中的检查
  ↓
Reviewer：汇总改动、测试结果、剩余风险

# 权限级别
| 级别 | 能力 | 是否自动执行 |
|---|---|---|
| P0 | `listDir`、`readFile`、`grep`、`git diff/status` | 可以 |
| P1 | 生成 Diff、创建编辑提案 | 可以，但不写盘 |
| P2 | 应用已审查的 patch、创建新源码文件 | 每次必须批准 |
| P3 | 运行 `pnpm lint`、`pnpm test` 等固定命令 | 每次必须批准 |
| 禁止 | `.env`、密钥、删除文件、迁移数据库、安装依赖、`git commit/push`、部署 | V1 永久禁止 |

# 优化计划
| Days | 学习重点 | 项目改造与验收 |
|---|---|---|
| 1–2 | Agent 边界、会话安全、成本与请求观测 | 修订产品规格；移除 `MOCK_USER_ID`；`POST /api/chats` 只使用 `session.user.id`，不信任客户端 `userId` |
| 3–4 | Zod、Structured Output、SSE/UI Stream | 建立 `RequirementAnalysisSchema`；把消息状态扩展为 `idle/streaming/tool/approval/error/done` |
| 5–7 | 原生工具调用与只读执行器 | 实现 `listDir/readFile/grep`；阻断敏感文件、越界路径、超大输出；完成一次带证据链的需求分析 |
| 8–10 | Agent loop、规划、代码库检索 | 接入 AI SDK `streamText + stopWhen`；实现 Planner；建立工具注册表与最大步数/重复调用保护 |
| 11–12 | Human-in-the-loop、Agent UX | 显示工具时间线、计划、证据；建立审批卡片，但此时审批仅用于演练，不写文件 |
| 13–14 | 检索质量与上下文预算 | 先做代码树、关键词检索、文档索引和来源引用；暂不上向量 RAG |
| 15–17 | 项目记忆、摘要、有依据规划 | 增加会话摘要、项目偏好；无证据的计划步骤必须标记“待确认” |
| 18–21 | Eval、安全、可观测性 | 建 25 条回归；加入路径穿越、提示注入、密钥访问、越权写入用例；为每个 run 建 trace |
| 22–23 | Patch 设计与可审查代码生成 | 新增 `PatchProposal`；生成 unified diff、变动文件树、风险、测试建议，但不落盘 |
| 24–25 | 受控编辑、幂等、冲突处理 | 引入 Agent 专用工作区；批准后原子应用 patch；基线 hash 冲突拒绝；重复批准不重复写入 |
| 26 | 验证执行 | 仅允许预定义 `lint/test/typecheck`；命令参数不可由模型自由拼接；输出截断、超时、审计 |
| 27–28 | 产品化与上线检查 | 编辑 Diff 视图、审批记录、回滚入口、手机端；限流、脱敏、依赖审计、README |
| 29–30 | 项目表达与最终验收 | 录制“PRD → 证据 → Diff → 批准 → 应用 → 验证”的 Demo；发布 Eval 和复盘报告 |

# scheme prisma 新增
model AgentRun {
  id          String   @id @default(uuid())
  chatId      String
  userId      String
  status      String   // planning | inspecting | awaiting_approval | editing | validating | done | failed
  workspaceId String
  traceId     String
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  proposals   PatchProposal[]
  toolCalls   ToolCallRecord[]
}

model PatchProposal {
  id             String   @id @default(uuid())
  runId          String
  diff           String
  diffHash       String
  summary        String
  status         String   // draft | approved | rejected | applied | stale | failed
  baseFileHashes Json
  createdAt      DateTime @default(now())
  approvedAt     DateTime?
  appliedAt      DateTime?

  run AgentRun @relation(fields: [runId], references: [id], onDelete: Cascade)
}

model ToolCallRecord {
  id           String   @id @default(uuid())
  runId        String
  toolName     String
  input        Json
  output       String?
  status       String   // ok | denied | awaiting_approval | error
  durationMs   Int?
  createdAt    DateTime @default(now())

  run AgentRun @relation(fields: [runId], references: [id], onDelete: Cascade)
}
PatchProposal 保存的是待审查的变更，不是“模型已经执行过的变更”。

# 工具设计
设置为受约束的工具集
type InspectorTools =
  | "listDir"
  | "readFile"
  | "grep"
  | "getGitDiff"

type EditorTools =
  | "createPatchProposal"
  | "applyApprovedPatch"
  | "runApprovedValidation"

createPatchProposal可以自动运行，但只能保存 Diff
```
export const createPatchProposal = tool({
  description: "根据已收集的证据生成可审查的 unified diff；不会修改文件。",
  inputSchema: PatchProposalSchema,
  execute: async (input) => {
    const proposal = await saveProposal({
      diff: input.diff,
      files: input.files,
      baseFileHashes: await hashCurrentFiles(input.files),
    })

    return {
      proposalId: proposal.id,
      status: "draft",
      previewUrl: `/agent/proposals/${proposal.id}`,
    }
  },
})
```

实际写入工具需要强制审批，只传入保存的id
```
export const applyApprovedPatch = tool({
  description: "将用户已经批准的 patch 应用到 Agent 工作区。",
  inputSchema: z.object({
    proposalId: z.string().uuid(),
  }),
  needsApproval: true,
  execute: async ({ proposalId }) => {
    const proposal = await getApprovedProposal(proposalId)

    await assertWorkspaceOwnership(proposal)
    await assertBaseFileHashesMatch(proposal)
    await applyPatchAtomically(proposal.diff)

    return { status: "applied", proposalId }
  },
})
```

# 文件修改限制
路径校验不能只检查是否包含 ../；Windows 上也必须处理绝对路径、反斜杠与符号链接。执行前解析真实路径，再判断它是否仍属于专用工作区：
```
import path from "node:path"
import { realpath } from "node:fs/promises"

export async function resolveWorkspaceFile(
  workspaceRoot: string,
  requestedPath: string,
) {
  if (path.isAbsolute(requestedPath) || requestedPath.includes("\0")) {
    throw new Error("PATH_DENIED")
  }

  const root = await realpath(workspaceRoot)
  const candidate = await realpath(path.resolve(root, requestedPath))
  const relative = path.relative(root, candidate)

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("PATH_DENIED")
  }

  return candidate
}
```

# 需要新增的接口和页面
POST /api/agent/runs
GET  /api/agent/runs/:runId
POST /api/agent/runs/:runId/approvals/:approvalId
GET  /api/agent/proposals/:proposalId
POST /api/agent/proposals/:proposalId/apply
POST /api/agent/proposals/:proposalId/validate
POST /api/agent/proposals/:proposalId/revert