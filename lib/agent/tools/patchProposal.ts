// lib/agent/tools/patchProposal.ts
//
// createPatchProposal：把模型给出的 unified diff 保存成**待审查提案**。
// 权限表：**可以自动执行，但不写盘**。
// 所以它不需要 needsApproval —— 它只往数据库写一条"待审查记录"，
// 不改工作区任何文件。真正的写盘是 applyApprovedPatch
// 与其它工具的关键差别：这是**第一个写数据库**的工具。
// 必须自己做三件事：
//   校验 diff（不可信输入，走 lib/agent/diff.ts）
//   计算基线 hash（审批绑定的依据）
//   设过期时间，默认30分钟
import { z } from 'zod'
import { tool } from 'ai'
import {
  buildDiffTree,
  parseAndValidateDiff,
  renderDiffTree,
  type DiffFile,
} from '../diff'
import { hashWorkspaceFiles, sha256, workspaceIdForCurrentCheckout } from '../workspace'
import { toToolErrorResult } from '../security'
import { createProposal } from '@/lib/repositories/proposalRepository'
import { logEvent } from '@/lib/logging'

/** 提案默认有效期（product-spec §11：编辑时限 30 分钟） */
export const PROPOSAL_TTL_MS = 30 * 60 * 1000

/** 测试建议：不落执行，只作为审查信息 */
export const PatchProposalInputSchema = z.object({
  diff: z.string().min(1).meta({
    description:
      '标准 unified diff 全文（含 diff --git / --- / +++ / @@ 头）。' +
      '**必须是可审查的统一 Diff**，不支持整文件替换、不包含删除或重命名文件的操作。' +
      '涉及文件不超过 10 个，总大小不超过 500KB。',
  }),
  summary: z.string().min(1).max(500).meta({
    description: '一句话说明这次改动做什么、为什么。审查者先看这句。',
  }),
  risks: z.array(z.string()).optional().meta({
    description: '这次改动的风险点，每条一句话。没有把握的地方写在这里，不要略过。',
  }),
  testSuggestions: z.array(z.string()).optional().meta({
    description: '建议执行的验证（如"pnpm run test 里补一条 X 的用例"）。只是建议，本工具不执行。',
  }),
})

export type PatchProposalInput = z.infer<typeof PatchProposalInputSchema>

export interface PatchProposalResult {
  ok: true
  proposalId: string
  status: 'draft'
  /** 变更文件树的可读渲染，让模型确认自己改了什么 */
  tree: string
  fileCount: number
  totalChangedLines: number
  /** 基线 hash，展示给用户用于人工核对 */
  baseFileHashes: Record<string, string>
  expiresAt: string
  /** 预览地址，前端据此打开审查面板 */
  previewUrl: string
  note: string
}

/**
 * 创建提案。
 *
 * ⚠️ runId 由调用方（route）提供，工具自己不知道 run 的存在 ——
 * 这是刻意的：工具保持"纯执行"，run 的生命周期归编排层。
 */
export async function createPatchProposal(
  input: PatchProposalInput,
  ctx: { runId: string; workspaceId?: string },
): Promise<PatchProposalResult | ReturnType<typeof toToolErrorResult>> {
  try {
    // 校验 diff —— 不可信输入的唯一入口
    const validation = parseAndValidateDiff(input.diff)
    if (!validation.ok) {
      // 返回结构化错误而不是抛异常：模型能读到 code 并据此修正 diff，
      // 而不是收到一个"工具执行失败"的黑盒
      return {
        ok: false,
        code: 'INVALID_INPUT',
        message: `diff 校验未通过（${validation.code}）：${validation.message}`,
      }
    }
    const { files, totalChangedLines } = validation.parsed

    // 计算基线 hash —— 审批绑定的依据（product-spec §3.2）
    const baseFileHashes = await hashWorkspaceFiles(files.map((f: DiffFile) => f.path))

    const workspaceId = ctx.workspaceId ?? workspaceIdForCurrentCheckout()
    const diffHash = sha256(input.diff)
    const expiresAt = new Date(Date.now() + PROPOSAL_TTL_MS)

    // 保存为 draft
    const proposal = await createProposal({
      runId: ctx.runId,
      workspaceId,
      diff: input.diff,
      diffHash,
      summary: input.summary,
      baseFileHashes,
      expiresAt,
    })

    const tree = renderDiffTree(buildDiffTree(files))

    logEvent('info', 'agent.proposalCreated', {
      proposalId: proposal.id,
      runId: ctx.runId,
      workspaceId,
      fileCount: files.length,
      totalChangedLines,
      diffBytes: Buffer.byteLength(input.diff, 'utf8'),
      // 只记 hash，不记 diff 内容
      diffHash,
    })

    return {
      ok: true,
      proposalId: proposal.id,
      status: 'draft',
      tree,
      fileCount: files.length,
      totalChangedLines,
      baseFileHashes,
      expiresAt: expiresAt.toISOString(),
      previewUrl: `/agent/proposals/${proposal.id}`,
      note:
        '提案已保存为 draft，**尚未修改任何文件**。' +
        '请把上面的文件树与风险点呈现给用户，由用户审查后决定是否批准。' +
        '不要声称已经修改了代码。',
    }
  } catch (err) {
    return toToolErrorResult(err)
  }
}

/**
 * AI SDK 的 tool 包装。
 * needsApproval 省略（= false）：本工具只写"待审查记录"，不改工作区。
 */
export const createPatchProposalTool = tool({
  description:
    '根据已收集的证据生成可审查的 unified diff 提案，**不会修改任何文件**。' +
    '适用于用户明确要求改动代码时。生成后必须把文件树、风险、测试建议展示给用户并等待审查。' +
    'diff 必须是标准 unified diff 格式；V1 不支持删除或重命名文件。',
  inputSchema: PatchProposalInputSchema,
  execute: async (input) => {
    // runId 由 tools/index.ts 的 guard 包装层注入
    return createPatchProposal(input, { runId: getCurrentRunId() })
  },
})

/**
 * 当前请求的 runId。
 *
 * 用模块作用域变量而不是参数：
 *   AI SDK 的 `tool()` 定义是**模块级**的（在 baseTools 里创建一次），
 *   而 runId 是**每请求**的。tool 的 execute 签名由 SDK 固定，
 *   拿不到额外的上下文。所以用一个"每请求设置一次"的载体。
 *
 * ⚠️ 单实例约束：本变量被 app/api/chat 每请求覆盖一次。
 *    Next.js 的 Node runtime 下请求不会并发共享同一模块实例到出错的程度，
 *    但**这确实是个已知弱点**：并发请求可能互相覆盖。
 *    更稳的做法是用 AsyncLocalStorage；V1 先接受这个弱点并在此记录。
 */
let currentRunId = 'no-run'

export function setCurrentRunId(runId: string): void {
  currentRunId = runId
}

export function getCurrentRunId(): string {
  return currentRunId
}