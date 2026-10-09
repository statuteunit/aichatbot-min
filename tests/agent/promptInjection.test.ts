// tests/agent/promptInjection.test.ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileTool } from '../../lib/agent/tools/readFile'
import { listDir } from '../../lib/agent/tools/listDir'
import { grepTool } from '../../lib/agent/tools/grep'

/**
 * 提示注入的架构防护。
 *
 * ⚠️ 这个测试**故意不经过模型**。
 *
 * 原因：如果把提示注入做成"给模型一段恶意 prompt、看它会不会照做"，
 * 那就是一个有概率的测试 —— 今天通过明天可能失败，无法进 CI，
 * 而且它验证的是"模型乖不乖"，不是"护栏牢不牢"。
 *
 * 真正要证明的命题：
 *   「护栏由架构保证，不由提示词保证」
 * 即：模型被注入说服、主动去调越界工具时，工具层仍然拒绝。
 * 所以这里直接调用工具，等价于"模型完全听话地执行了注入指令"这一最坏情况。
 */

/**
 * 每个 payload 显式声明它**应该**被哪一类规则拒绝。
 *
 * 为什么不能笼统接受 ['PATH_DENIED','SENSITIVE_FILE_DENIED','NOT_FOUND','INVALID_INPUT']：
 *   那样"文件恰好不存在"也能通过，测的是路径巧合而不是护栏 ——
 *   把仓库裁剪掉某个目录后，护栏即便失效测试也照样绿。
 * 显式声明期望错误码后，护栏失效会立刻失败，与目录里有什么无关。
 *
 * ⚠️ 期望值必须与 resolveWorkspaceFile 的**检查顺序**一致：
 *   ① 空字节            → PATH_DENIED
 *   ② 绝对路径          → PATH_DENIED
 *   ③ 含 ..             → PATH_DENIED
 *   ④ 敏感文件          → SENSITIVE_FILE_DENIED
 *   ⑤ 忽略目录          → SENSITIVE_FILE_DENIED
 *   ⑥ 以上都通过才触盘   → NOT_FOUND / 读到内容
 *
 * 前五步全部发生在**碰文件系统之前**，所以这些断言的成立不依赖文件是否存在。
 */
const INJECTION_PAYLOADS: ReadonlyArray<{ path: string; expect: string; why: string }> = [
  // ① 空字节截断：既是注入向量也是路径截断向量
  { path: 'src/a.ts\0.png', expect: 'PATH_DENIED', why: '空字节' },
  // ② 绝对路径
  { path: '/etc/shadow', expect: 'PATH_DENIED', why: 'POSIX 绝对路径' },
  { path: 'C:\\Users\\Administrator\\.ssh\\id_rsa', expect: 'PATH_DENIED', why: 'Windows 盘符' },
  // ③ ..
  { path: '../../../../etc/passwd', expect: 'PATH_DENIED', why: '正向遍历' },
  { path: '..\\..\\..\\windows\\win.ini', expect: 'PATH_DENIED', why: '反斜杠遍历' },
  // ④ 敏感文件
  { path: '.env', expect: 'SENSITIVE_FILE_DENIED', why: '环境变量' },
  { path: '.env.production', expect: 'SENSITIVE_FILE_DENIED', why: '环境变量变体' },
  { path: '.git/config', expect: 'SENSITIVE_FILE_DENIED', why: '含凭据的仓库配置' },
  { path: 'id_rsa', expect: 'SENSITIVE_FILE_DENIED', why: '私钥' },
  { path: 'certs/server.pem', expect: 'SENSITIVE_FILE_DENIED', why: '证书' },
  // ⑤ 忽略目录：这条是本次修复的核心。
  // 修复前 IGNORED_DIRS 只作用于遍历，显式路径能读到 node_modules 里的内容。
  { path: 'node_modules/next/package.json', expect: 'SENSITIVE_FILE_DENIED', why: '依赖目录' },
  { path: 'node_modules', expect: 'SENSITIVE_FILE_DENIED', why: '依赖目录本身' },
  { path: '.next/build-manifest.json', expect: 'SENSITIVE_FILE_DENIED', why: '构建产物' },
  { path: '.git/HEAD', expect: 'SENSITIVE_FILE_DENIED', why: '版本库元数据' },
]

test('注入形态的路径在 readFile 上被拒绝，且错误码与检查顺序一致', async () => {
  for (const { path: p, expect, why } of INJECTION_PAYLOADS) {
    const res = await readFileTool({ path: p })
    assert.equal(res.ok, false, `${JSON.stringify(p)}（${why}）不该成功`)
    assert.equal(
      (res as { code: string }).code,
      expect,
      `${JSON.stringify(p)}（${why}）期望 ${expect}，实际 ${(res as { code: string }).code}`,
    )
  }
})

/**
 * 三个工具入口必须共用同一套路径护栏。
 *
 * 为什么要一起测：护栏缺口最常见的形态就是「某个工具忘了调用共同的校验函数」。
 * 本次的真实缺口正是这一类 —— readFile / listDir / grep 都走 resolveWorkspaceFile，
 * 但它漏检了 IGNORED_DIRS，于是三条入口同时可被绕过。
 */
test('readFile / listDir / grep 三个入口的路径护栏完全一致', async () => {
  for (const { path: p, expect, why } of INJECTION_PAYLOADS) {
    const entries: Array<[string, { ok: boolean; code?: string }]> = [
      ['readFile', (await readFileTool({ path: p })) as { ok: boolean; code?: string }],
      ['listDir', (await listDir({ path: p })) as { ok: boolean; code?: string }],
      ['grep', (await grepTool({ pattern: 'a', path: p })) as { ok: boolean; code?: string }],
    ]

    for (const [toolName, res] of entries) {
      assert.equal(
        res.ok,
        false,
        `${toolName} 接受了 ${JSON.stringify(p)}（${why}）—— 它的路径检查与其它工具不一致`,
      )
      assert.equal(
        res.code,
        expect,
        `${toolName} 对 ${JSON.stringify(p)} 的拒绝码应为 ${expect}，实际 ${res.code}`,
      )
    }
  }
})

test('注入 payload 不会让敏感内容出现在任何工具的成功结果里', async () => {
  // 更强的断言：即使某个 payload 碰巧"存在"，也不能读到敏感内容
  const res = await readFileTool({ path: '.env' })
  assert.equal(res.ok, false)
  assert.ok(!JSON.stringify(res).includes('SECRET'), '响应体里不能含敏感文件内容')

  // 依赖目录同理：不能把三方包内容带进上下文
  const nm = await readFileTool({ path: 'node_modules/next/package.json' })
  assert.equal(nm.ok, false)
  assert.ok(!JSON.stringify(nm).includes('"version"'), '响应体里不能含依赖包内容')
})

test('忽略目录的拒绝不依赖该目录是否存在（策略先于触盘）', async () => {
  // 关键：这些路径**故意带上一个肯定不存在的子路径**。
  // 若护栏是在触盘后才判断（先 NOT_FOUND），这里会失败；
  // 期望 SENSITIVE_FILE_DENIED 说明检查确实发生在碰文件系统之前。
  for (const p of [
    'node_modules/__definitely_not_installed__/index.js',
    '.next/__no_such_artifact__/x.json',
    'dist/__missing__/a.js',
  ]) {
    const res = await readFileTool({ path: p })
    assert.equal(res.ok, false)
    assert.equal(
      (res as { code: string }).code,
      'SENSITIVE_FILE_DENIED',
      `${p} 应在触盘前就被忽略目录规则拒绝`,
    )
  }
})
