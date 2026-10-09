// app/api/agent/file/route.ts
//
// 读取工作区内某文件的指定行区间，供前端「点击 file:line → 在 Artifact 面板打开」使用。
//
// 为什么复用 readFileTool 而不是自己实现：
//   路径白名单、敏感文件屏蔽、200KB 上限、符号链接逃逸校验都在 security.ts 里，
//   复用之后，前端能看到的文件范围与 Agent 能看到的**完全一致**，
//      不会出现"Agent 看不到但 UI 能看"的旁路。
//
// 与 Agent 工具的区别：这是**用户主动发起**的读取（点链接），不是模型决策，
// 所以不需要 guard 的文件预算；但敏感文件屏蔽照旧生效（.env 依然 403）。
import { requireUserId } from '@/lib/api/auth'
import { withApiLogging, getRequestId } from '@/lib/api/observability'
import { readFileTool } from '@/lib/agent/tools/readFile'
import { findFilesByBasename, getWorkspaceRoot } from '@/lib/agent/security'

/** 单次返回的最大行数：防止一次请求把整个大文件塞进响应体 */
const MAX_LINES_PER_REQUEST = 500

/** 歧义时最多返回几个候选 */
const MAX_CANDIDATES = 10

export const GET = withApiLogging({
  event: 'agent.file.GET',
  handler: async (req: Request) => {
    // requestId 从 Request 上取，不靠位置参数（见 observability.ts 的说明）
    const requestId = getRequestId(req)
    // 只要登录即可读——读取仍受 security.ts 的路径与敏感文件约束
    await requireUserId()

    const { searchParams } = new URL(req.url)
    const path = searchParams.get('path')
    if (!path) {
      return Response.json({ error: 'MISSING_PATH', requestId }, { status: 400 })
    }

    const parseLine = (raw: string | null): number | undefined => {
      if (!raw) return undefined
      const n = Number(raw)
      return Number.isInteger(n) && n > 0 ? n : undefined
    }

    const startLine = parseLine(searchParams.get('startLine'))
    const endLine = parseLine(searchParams.get('endLine'))
    // 若给了起点没给终点，读一个窗口而不是整文件
    const effectiveEnd =
      endLine ?? (startLine !== undefined ? startLine + MAX_LINES_PER_REQUEST - 1 : undefined)

    /** 按一个具体路径读取 */
    const tryRead = (candidate: string) =>
      readFileTool({ path: candidate, startLine, endLine: effectiveEnd })

    let resolvedPath = path
    let result = await tryRead(path)

    // 兜底：模型经常只写文件名（实测 `prompt.ts:27`、`index.ts:23-25`，
    // 真实路径是 lib/agent/prompt.ts）。直接 404 会让用户点到的链接变成死链，
    // 所以按同名文件再找一次：唯一命中就用它，多个命中就返回候选让用户选。
    if (!result.ok && result.code === 'NOT_FOUND') {
      const basename = path.split(/[/\\]/).pop() ?? path
      const candidates = await findFilesByBasename({
        workspaceRoot: getWorkspaceRoot(),
        basename,
        maxResults: MAX_CANDIDATES,
      })

      if (candidates.length === 1) {
        resolvedPath = candidates[0]
        result = await tryRead(resolvedPath)
      } else if (candidates.length > 1) {
        // 409 而不是 404：文件确实存在，只是模型没说是哪一个。
        // 前端据此可以列出候选，而不是简单标记"打不开"。
        return Response.json(
          {
            error: 'AMBIGUOUS_PATH',
            message: `仓库里有多个 ${basename}，需要完整相对路径`,
            requestedPath: path,
            candidates,
            requestId,
          },
          { status: 409 },
        )
      }
    }

    if (!result.ok) {
      // 工具层的错误码直接透出，但 HTTP 状态要合理：
      // 敏感文件不是"服务端错误"，用 403 让前端能区分
      const status =
        result.code === 'SENSITIVE_FILE_DENIED' || result.code === 'PATH_DENIED'
          ? 403
          : result.code === 'NOT_FOUND'
            ? 404
            : result.code === 'OUTPUT_TOO_LARGE'
              ? 413
              : 400
      return Response.json({ error: result.code, message: result.message, requestId }, { status })
    }

    return Response.json({
      path: result.path,
      // 发生了兜底解析时告诉前端：原始引用与真实路径不一致，便于排查提示词问题
      ...(resolvedPath !== path ? { resolvedFrom: path } : {}),
      startLine: result.startLine,
      endLine: result.endLine,
      totalLines: result.totalLines,
      truncated: result.truncated,
      content: result.content,
      requestId,
    })
  },
})
