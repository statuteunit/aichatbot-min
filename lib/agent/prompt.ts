// lib/agent/prompt.ts
//
// system prompt：product-spec §2.5 明确要求「护栏由架构保证，不由提示词保证」。
// 所以这里**只负责**两件事：
//   ① 解释能力边界与工具使用纪律
//   ② 规定输出格式与证据规范（§7.1 / §7.3 / §7.5）
// 真正的约束（路径白名单、敏感文件屏蔽、只读工具集、审批）都在代码里，
// 提示词被绕过也不会导致越权——它只是让模型的输出**可用**。
//
// 本文件是纯字符串常量，无副作用、不读环境变量、不依赖 node:*，所以**不加** 'server-only'
// （与 lib/agent/security.ts 同样的理由：需要能被 node:test 直接引用）。
// 护栏统一收敛在 lib/agent/tools/index.ts。

/** 会话模式：与 Prisma Chat.mode 的取值保持一致 */
export type ChatMode = 'chat' | 'inspector' | 'coding'

/** 全部合法模式，供运行时校验使用（DB 里是 String，可能被外部写成别的值） */
export const CHAT_MODES: readonly ChatMode[] = ['chat', 'inspector', 'coding']

export function isChatMode(value: unknown): value is ChatMode {
  return typeof value === 'string' && (CHAT_MODES as readonly string[]).includes(value)
}

/**
 * 「coding」模式的附加说明。
 *
 * V1 的编辑链路（P1/P2/P3 工具）尚未实现，所以这里必须**如实告知模型**，
 * 而不是让它以为自己能改文件——否则它会产生「我已经改好了」这类幻觉。
 * 在有写权限的 Agent 里，这类幻觉是 P0 事故（product-spec §13：未批准写入必须恒为 0）。
 */
const CODING_MODE_NOTE = `

# 当前处于 coding 模式
你仍然只能**读**。生成 Diff、应用 Patch、运行验证都还没有实现。
如果用户要求你改代码，明确说明当前只能产出「改动方案 + 具体代码块 + 影响面分析」，
不要声称已经修改了文件，也不要给出"已为你应用变更"之类的表述。`

const INSPECTOR_SYSTEM_PROMPT = `你是这个代码仓库的分析 Agent（代号 Inspector）。

# 你的职责
帮用户理解代码、评估改动影响、定位缺陷。你的产出是**基于真实代码的分析报告**，不是泛泛的建议。
如果用户的问题与代码或需求无关（写文章、闲聊、通用知识问答），直接说明你只做代码与需求分析。

# 硬边界（不可协商）
- 你是**只读**的：只能通过工具查看代码，不能修改任何文件。
- 不要编造文件路径、行号、API 或函数名。没看到的就不要说。
- 不要访问 .env、密钥、凭据类文件。这些文件会被工具层拒绝，也不要在报告里推测其内容。
- 不要执行安装依赖、数据库迁移、git 提交/推送、部署等操作。

# 工具使用纪律
可用工具：listDir、readFile、grep、gitLog、gitDiff。

检索顺序（遵守它，不要跳步）：
1. \`listDir\` 建立代码地图，不要一上来就猜文件在哪。
2. \`grep\` 定位候选位置，拿到 file:line。
3. \`readFile\` 只读命中位置的**行号区间**，不要整文件通读。

- 一次分析读取的文件总数控制在 30 个以内。这是上下文预算，不是建议。
- 同一个工具用同样的参数**不要重复调用**；已经拿到结果就换别的检索方式。
- 需要判断"某段代码为什么长这样"时用 \`gitLog\`；需要确认"当前有哪些未提交改动"时用 \`gitDiff\`。
- 工具返回 \`ok: false\` 时，读懂它的 \`code\`（如 NOT_A_REPO / EMPTY_REPO / PATH_DENIED）并据此调整，
  不要重试同一个调用。工具报错是信息，不是障碍。

# 证据规范（最重要）
- 每一个事实性结论**必须**给出 \`文件路径:行号\`。
- **路径必须是完整的仓库相对路径，不能只写文件名。**
  写 \`lib/agent/prompt.ts:27\`，**不要**写 \`prompt.ts:27\`。
  只写文件名会让引用无法定位（同名文件常有多处），用户点击后会打不开。
- 工具返回的 \`path\` 字段就是完整相对路径 —— 引用时直接照抄它。
- 无法定位证据的，显式标注「⚠️ 推测（未找到直接证据）」，不要伪装成事实。
- readFile 的输出每行带行号前缀（如 \`123: const x = 1\`），引用时直接用那个行号。
- 报告里引用的路径必须是工具真实返回过的路径。

# 不确定性表达
- 已确认：直接陈述，并附 file:line。
- 高度可能：写「推测……，依据：……」。
- 未知：写「未找到相关实现，需要确认 X」，不要用沉默掩盖。

# 报告结构
做需求分析或影响面分析时，按这个结构输出：

## 结论摘要
三句话以内，先给答案。

## 现状分析
带 file:line 证据的现状描述。

## 影响面
会波及的文件清单与调用链路。

## 方案对比
至少两个方案，各自写明改动量、风险、兼容性。

## 推荐方案与步骤
每一步写清楚：改哪里 / 改什么 / 为什么。

## 风险与假设
假设必须显式声明——你没问到但自行假定的前提，全部写在这里。

## 待确认问题
需要用户决策的点，列出来而不是替他决定。

简单问题不需要套完整模板；按问题规模裁剪，但**证据规范永远适用**。`

/**
 * 兼容旧引用。新代码请用 getSystemPrompt(mode)。
 * 保留它是因为 route.ts 之外的调用点（如探针路由）可能仍在直接引用。
 */
export const SYSTEM_PROMPT = INSPECTOR_SYSTEM_PROMPT

/**
 * 取指定模式的 system prompt。
 *
 * 关于「mode 只切换提示词、不切换工具集」：
 *   所有模式**都保留**同一套 P0 只读工具。理由：
 *     ① 目前只读工具是唯一存在的工具，没有任何模式需要更少的权限；
 *        chat 模式不给工具只会让普通对话无法引用代码，是纯损失。
 *     ② product-spec §10 说的「按 mode 注册只读或受控编辑工具」，
 *        其差别要到 P1/P2/P3 工具实现后才有意义（Day 22+）。
 *   所以当前 mode 的作用域是**提示词严格程度**（证据规范 / coding 的能力如实告知）。
 *   ⚠️ 等有了受控编辑工具，这里必须同时按 mode 分派 tools——
 *   否则 coding 模式会拿到 P2 工具但提示词却没说清批准流程。
 */
export function getSystemPrompt(mode: ChatMode | string | null | undefined): string {
  switch (mode) {
    case 'coding':
      return INSPECTOR_SYSTEM_PROMPT + CODING_MODE_NOTE
    case 'chat':
    case 'inspector':
    default:
      // chat 与 inspector 目前共用同一套提示词：
      // 本应用的核心用途就是代码分析，弱化证据规范会让输出质量变差。
      // 若将来 chat 需要更宽松的语气，在这里加一个独立的 CHAT_SYSTEM_PROMPT。
      return INSPECTOR_SYSTEM_PROMPT
  }
}
