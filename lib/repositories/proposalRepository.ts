// lib/repositories/proposalRepository.ts
// PatchProposal / AgentRun 的持久化。
import 'server-only'
import { prisma } from '@/lib/db'
import { logEvent } from '@/lib/logging'

export interface CreateProposalParams {
  runId: string
  workspaceId: string
  diff: string
  diffHash: string
  summary: string
  baseFileHashes: Record<string, string>
  expiresAt: Date
}

/** 创建 draft 提案 */
export async function createProposal(params: CreateProposalParams) {
  return prisma.patchProposal.create({
    data: {
      runId: params.runId,
      workspaceId: params.workspaceId,
      diff: params.diff,
      diffHash: params.diffHash,
      summary: params.summary,
      baseFileHashes: params.baseFileHashes,
      status: 'draft',
      expiresAt: params.expiresAt,
    },
    select: { id: true, status: true, expiresAt: true },
  })
}

/**
 * 按 id 取提案，并校验它属于该用户。
 *
 * 为什么必须连 userId 一起查（而不是先查再比）：
 *   分两步会在两步之间留下时间窗，也让"是否泄漏存在性"取决于实现细节。
 *   一步 join 过滤，不属于该用户时**直接返回 null**，与"不存在"不可区分。
 */
export async function getProposalForUser(proposalId: string, userId: string) {
  return prisma.patchProposal.findFirst({
    where: {
      id: proposalId,
      run: { userId },
    },
    select: {
      id: true,
      runId: true,
      workspaceId: true,
      diff: true,
      diffHash: true,
      summary: true,
      baseFileHashes: true,
      status: true,
      expiresAt: true,
      approvedBy: true,
      approvedAt: true,
      appliedAt: true,
      createdAt: true,
    },
  })
}

/** 列出某个 run 下的提案（按创建时间倒序） */
export async function listProposalsForRun(runId: string, userId: string) {
  return prisma.patchProposal.findMany({
    where: { runId, run: { userId } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      summary: true,
      status: true,
      expiresAt: true,
      createdAt: true,
      diffHash: true,
    },
  })
}

/**
 * 惰性标记过期提案。
 *
 * 要求提案 30 分钟过期。
 * 用一个定时任务去扫是过度设计；在读的时候顺手把"已过期但状态还是 draft"
 * 的提案标成 stale 即可 —— 状态最终一致，且不引入新的基础设施。
 * 返回被标记的数量，供调用方记日志。
 */
export async function markExpiredProposalsStale(runId: string): Promise<number> {
  const now = new Date()
  const res = await prisma.patchProposal.updateMany({
    where: { runId, status: 'draft', expiresAt: { lt: now } },
    data: { status: 'stale' },
  })
  if (res.count > 0) {
    logEvent('info', 'agent.proposalsExpired', { runId, count: res.count })
  }
  return res.count
}

/**
 * 创建 AgentRun。
 *
 * 当前 PatchProposal 必须有 runId 外键 ——
 * 没有 run，提案就没有归属，审批也就无从绑定。
 */
export async function createAgentRun(params: {
  chatId: string
  userId: string
  workspaceId: string
  traceId: string
  status?: string
}) {
  return prisma.agentRun.create({
    data: {
      chatId: params.chatId,
      userId: params.userId,
      workspaceId: params.workspaceId,
      traceId: params.traceId,
      status: params.status ?? 'inspecting',
    },
    select: { id: true, status: true },
  })
}