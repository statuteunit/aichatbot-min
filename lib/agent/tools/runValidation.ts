// lib/agent/tools/runValidation.ts
// runApprovedValidation：P3 —— 在**用户批准**后执行注册的验证任务。
// 为什么必须单独成一个工具，而不是让模型自己跑命令：
//   一旦允许模型提供命令字符串，白名单就退化成"事后检查"，注入面已经打开了。
//   这里 inputSchema 只有 proposalId + taskId（zod enum 三个值），
//   没有任何地方能塞命令、参数、环境变量或工作目录。
import { z } from 'zod'
import { tool } from 'ai'
import {
  isValidationTaskId,
  runValidationTask,
  VALIDATION_TASK_IDS,
} from '@/lib/agent/validation'
import { getWorkspaceRoot, toToolErrorResult } from '@/lib/agent/security'
import { getCurrentUserId } from '@/lib/agent/runContext'
import { workspaceIdForCurrentCheckout } from '@/lib/agent/workspace'
import { findOwnedProposalForValidation } from '@/lib/repositories/proposalRepository'

export const RunValidationInputSchema = z.object({
  proposalId: z.string().min(1).meta({
    description: '要验证的提案 id。验证只对**已经应用**该提案的工作区有意义。',
  }),
  taskId: z.enum(['lint', 'typecheck', 'test']).meta({
    description:
      `注册的验证任务 id，只能是 ${VALIDATION_TASK_IDS.join(' / ')} 之一。` +
      '不接受命令字符串、参数、环境变量或工作目录 —— 具体命令由服务端固定映射。',
  }),
})

export const runValidationTool = tool({
  description:
    '在一个**已被用户批准并已应用**的提案上运行注册的验证任务（lint / typecheck / test），' +
    '返回退出码、截断后的日志与耗时。需要用户在审批卡片上批准才会执行。' +
    '只能选择注册的任务 id，参数由服务端决定；它不会修改任何文件（lint 不加 --fix，tsc 用 --noEmit）。',
  inputSchema: RunValidationInputSchema,
  needsApproval: true, // P3：product-spec 要求验证必须人工批准
  execute: async (input) => {
    try {
      const userId = getCurrentUserId()
      if (!userId) {
        return { ok: false, code: 'INTERNAL_ERROR', message: '缺少用户上下文，拒绝执行验证' }
      }

      // zod enum 已经挡过一次；这里是第二道，防止 schema 被绕过或被改坏
      if (!isValidationTaskId(input.taskId)) {
        return {
          ok: false,
          code: 'INVALID_INPUT',
          message: `未注册的验证任务：${String(input.taskId)}`,
          hint: `只能从 ${VALIDATION_TASK_IDS.join(' / ')} 里选。不要尝试构造命令。`,
        }
      }

      const proposal = await findOwnedProposalForValidation({ proposalId: input.proposalId, userId })
      if (!proposal) {
        return {
          ok: false,
          code: 'NOT_FOUND',
          message: '找不到该提案，或它不属于当前用户。',
          hint: '请用 createPatchProposal 重新生成提案，不要重试本调用。',
        }
      }
      if (proposal.status !== 'applied') {
        return {
          ok: false,
          code: 'PROPOSAL_NOT_APPLIED',
          message: `提案当前状态为 ${proposal.status}，只有 applied 的提案才能验证。`,
          hint:
            '验证必须在提案被批准并应用之后：请在审批卡片上点「批准」完成应用，' +
            '然后再调用本工具。不要重试同一个调用。',
        }
      }
      if (proposal.workspaceId !== workspaceIdForCurrentCheckout()) {
        return {
          ok: false,
          code: 'WORKSPACE_CHANGED',
          message: '提案是在另一个工作区创建的，拒绝执行验证。',
          hint: '请重新读取文件并重新生成提案。',
        }
      }

      const outcome = await runValidationTask(input.taskId, getWorkspaceRoot())
      return {
        ok: outcome.ok,
        code: outcome.ok ? undefined : 'VALIDATION_FAILED',
        taskId: outcome.taskId,
        exitCode: outcome.exitCode,
        durationMs: outcome.durationMs,
        truncated: outcome.truncated,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        message: outcome.ok
          ? `验证任务 ${outcome.taskId} 通过（退出码 0，耗时 ${outcome.durationMs}ms）。`
          : `验证任务 ${outcome.taskId} **未通过**（退出码 ${outcome.exitCode}，耗时 ${outcome.durationMs}ms）。` +
          (outcome.truncated ? '日志已被截断，只保留了前 40KB。' : '') +
          '请如实转述失败与日志摘要，不要声称你已经修好了；' +
          '若要修复，请基于日志生成**新的**提案。',
      }
    } catch (err) {
      return toToolErrorResult(err)
    }
  },
})