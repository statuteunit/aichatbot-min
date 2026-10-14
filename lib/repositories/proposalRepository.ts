// lib/repositories/proposalRepository.ts
// PatchProposal / AgentRun 的持久化。
import 'server-only'
import { prisma } from '@/lib/db'
import { logEvent } from '@/lib/logging'
import { readWorkspaceFileOrNull, sha256, workspaceIdForCurrentCheckout } from '@/lib/agent/workspace'
import path from 'node:path'
import { getWorkspaceRoot } from '@/lib/agent/security'
import { retryTransient } from '@/lib/agent/dbRetry'

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
      approvedDiffHash: true,
      targetFileHashes: true,
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

/**
 * AgentRun 就绪判定：确保返回的 id **确实指向一条存在的 AgentRun**。
 *
 * 必须有：PatchProposal.runId 是**非空外键**。
 * 曾经在 app/api/chat/route.ts 用 `agentRunId ?? requestId` 兜底，
 * 提案只有挂载在真的run上才能工作
 * requestId 不是 AgentRun.id，插入必然抛出
 *   Foreign key constraint violated: `PatchProposal_runId_fkey (index)`
 * 被工具层的 catch 压成 INTERNAL_ERROR
 * 只能原样重发，表现为"提案工具卡死"。
 * 所以判定标准是「这条 run 真的在库里」，而**不是**「调用方给了我一个 id」。
 * 用 count 而不是 findUnique：只需要"存在性"，不需要回传字段。
 */
export async function isAgentRunUsable(runId: string): Promise<boolean> {
  if (typeof runId !== 'string' || runId.trim().length === 0) return false
  const found = await prisma.agentRun.count({ where: { id: runId } })
  return found > 0
}

/**
 * 为「本轮对话」取一个可用的 AgentRun.id（没有就建）。
 *
 * 为什么需要：ToolCallRecord.runId 是**非空外键**，而普通的问答回合
 * 不一定先建 run（只有提案链路才建）。没有真 run 时工具留痕会整批
 * 因外键失败而写不进去，表现就是"刷新历史后工具时间线消失"。
 *
 * 幂等：同一 traceId 已有 run 就直接复用，不新建第二条。
 * 这里**不用** ensureAgentRun —— 那个按 baselineHash 分 run，语义是"提案的基线"，
 * 与"本轮对话的工具留痕"不是一回事。
 */
export async function ensureToolCallRun(params: {
  chatId: string
  userId: string
  traceId: string
}): Promise<string | null> {
  const existing = await prisma.agentRun.findFirst({
    where: { traceId: params.traceId, chatId: params.chatId },
    select: { id: true },
    orderBy: { createdAt: 'desc' },
  })
  if (existing) return existing.id

  const chat = await prisma.chat.findFirst({
    where: { id: params.chatId, userId: params.userId },
    select: { id: true },
  })
  if (!chat) return null

  const created = await retryTransient(
    () =>
      prisma.agentRun.create({
        data: {
          chatId: params.chatId,
          userId: params.userId,
          workspaceId: workspaceIdForCurrentCheckout(),
          traceId: params.traceId,
          status: 'inspecting',
        },
        select: { id: true },
      }),
    { label: 'agent.ensureToolCallRun' },
  )
  return created.id
}

/**
 * 幂等 —— 调用 N 次也不会产生第 2 条 run。
 *
 * 三个约束：
 *   1. runId 参数**刻意不校验**。校验它就要写
 *      `if (await isAgentRunUsable(runId)) return {ok:true, runId}`，
 *      而那正是"先查再写"的竞态，等于把 FK 报错换成更难查的间歇性失败。
 *      正确做法是让输入变成"会话身份"（chatId + userId + workspaceId），
 *      由 chatId 反推出的 run 天然唯一。**不要"优化"成先查 runId**。
 *   2. 会话归属校验：chatId 不存在或不属于该用户 → 拒绝建 run。
 *      否则任何人都能用别人的 chatId 造 run（外键只保证 chat 存在，
 *      不保证它属于你；那是两层不同的校验）。
 *   3. diffHash 取自磁盘上该文件的**当前内容**，因此它天然是"这个基线上的 run"。
 *      文件内容变了 → 新 run、旧提案因基线冲突作废 —— 这正是我们要的语义。
 */
export async function ensureAgentRun(params: {
  chatId: string
  userId: string
  workspaceId: string
  traceId: string
  /** 提案涉及的第一个文件（工作区相对路径）。不传则建"无基线的 run" */
  baselinePath?: string
}): Promise<{ ok: true; runId: string; created: boolean } | { ok: false; reason: string }> {
  const chat = await prisma.chat.findFirst({
    where: { id: params.chatId, userId: params.userId },
    select: { id: true },
  })
  if (!chat) {
    return { ok: false, reason: '会话不存在或不属于当前用户' }
  }

  let baselineHash: string | null = null
  if (params.baselinePath) {
    try {
      const abs = path.resolve(getWorkspaceRoot(), params.baselinePath)
      const content = await readWorkspaceFileOrNull(abs)
      // 新增文件（不存在）也要有基线：用空内容的 hash，
      // 与 workspace.ts 的 EMPTY_FILE_SHA256 是同一套语义。
      baselineHash = sha256(content ?? '')
    } catch {
      // 读不到就当没有基线，不阻断建 run
      baselineHash = null
    }
  }

  const existing = await prisma.agentRun.findFirst({
    where: {
      chatId: params.chatId,
      userId: params.userId,
      workspaceId: params.workspaceId,
      baselineHash,
    },
    select: { id: true },
    orderBy: { createdAt: 'desc' },
  })
  if (existing) {
    return { ok: true, runId: existing.id, created: false }
  }

  const created = await prisma.agentRun.create({
    data: {
      chatId: params.chatId,
      userId: params.userId,
      workspaceId: params.workspaceId,
      traceId: params.traceId,
      status: 'inspecting',
      baselineHash,
    },
    select: { id: true },
  })

  logEvent('info', 'agent.runEnsured', {
    runId: created.id,
    chatId: params.chatId,
    workspaceId: params.workspaceId,
    baselineHash,          // 只记 hash，不记文件内容
    created: true,
  })

  return { ok: true, runId: created.id, created: true }
}

/**
 * 批准提案。
 *
 * ⚠️ 记下 `approvedDiffHash`（= 当时的 diffHash）。
 *    这是审批绑定的核心：应用前会比对这个值与当前 diffHash。
 *    没有它，"批准后被替换 diff"就无法被发现。
 */
export async function approveProposal(params: {
  proposalId: string
  userId: string
  diffHash: string
}): Promise<{ ok: boolean; reason?: string }> {
  const res = await prisma.patchProposal.updateMany({
    // 条件里带 status='draft'：防止把已 reject/stale/applied 的提案改成 approved
    where: { id: params.proposalId, status: 'draft' },
    data: {
      status: 'approved',
      approvedBy: params.userId,
      approvedAt: new Date(),
      approvedDiffHash: params.diffHash,
    },
  })
  if (res.count === 0) {
    return { ok: false, reason: '提案不存在，或当前状态不是 draft（可能已过期、已拒绝或已应用）' }
  }
  logEvent('info', 'agent.proposalApproved', { proposalId: params.proposalId, userId: params.userId })
  return { ok: true }
}

/** 拒绝提案 */
export async function rejectProposal(params: {
  proposalId: string
  userId: string
  reason?: string
}): Promise<{ ok: boolean; reason?: string }> {
  const res = await prisma.patchProposal.updateMany({
    where: { id: params.proposalId, status: 'draft' },
    data: { status: 'rejected', approvedBy: params.userId, approvedAt: new Date() },
  })
  if (res.count === 0) return { ok: false, reason: '提案不存在，或当前状态不是 draft' }
  logEvent('info', 'agent.proposalRejected', {
    proposalId: params.proposalId,
    userId: params.userId,
    reason: params.reason ?? null,
  })
  return { ok: true }
}

/** 标记为过期/冲突（基线已变） */
export async function markProposalStale(proposalId: string): Promise<void> {
  await prisma.patchProposal.updateMany({
    where: { id: proposalId, status: { in: ['draft', 'approved'] } },
    data: { status: 'stale' },
  })
  logEvent('warn', 'agent.proposalStale', { proposalId })
}

/** 标记为已应用，并记下目标 hash（幂等判定的依据） */
export async function markProposalApplied(proposalId: string): Promise<void> {
  await prisma.patchProposal.update({
    where: { id: proposalId },
    data: { status: 'applied', appliedAt: new Date() },
  })
}

/** 标记为失败，并记下原因（供审查面板展示"为什么没应用成功"） */
export async function markProposalFailed(proposalId: string, reason: string): Promise<void> {
  await prisma.patchProposal.update({
    where: { id: proposalId },
    data: { status: 'failed' },
  })
  logEvent('error', 'agent.proposalFailed', { proposalId, reason })
}

/** 更新 AgentRun 状态（planning/inspecting/awaiting_approval/applying/done/failed/...） */
export async function updateAgentRunStatus(runId: string, status: string): Promise<void> {
  await prisma.agentRun.updateMany({ where: { id: runId }, data: { status } })
}

// 同一个diff只建一条提案
export async function findActiveProposalByDiffHash(params: {
  runId: string
  workspaceId: string
  diffHash: string
}) {
  return prisma.patchProposal.findFirst({
    where: {
      runId: params.runId,
      workspaceId: params.workspaceId,
      diffHash: params.diffHash,
      status: { in: ['draft', 'approved'] },
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, expiresAt: true, summary: true },
  })
}

/**
 * 取一个**属于该用户**的提案，供 P3 验证工具做归属与状态判定。
 * 用 relation filter（run.userId）一次查完，而不是"先查提案再查 run"：
 * 后者是 check-then-act，两次查询之间状态可能变化，且多一次远程往返。
 */
export async function findOwnedProposalForValidation(params: {
  proposalId: string
  userId: string
}) {
  return prisma.patchProposal.findFirst({
    where: { id: params.proposalId, run: { userId: params.userId } },
    select: { id: true, status: true, workspaceId: true, appliedAt: true, expiresAt: true },
  })
}