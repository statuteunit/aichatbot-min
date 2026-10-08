/**
 * 一次性清理脚本：删除 Message 表里 id = '' 的残留行。
 *
 * 背景
 * ----
 * 在修复「AI 消息丢失」之前，@ai-sdk/react 的 useChat 因为没传 generateId，
 * 会给 Assistant 响应消息一个**空字符串** id。空串满足 TEXT NOT NULL、
 * 也满足主键唯一性，于是 upsertAssistantMessage 的 upsert 从第二次起
 * 一直命中同一行、在 update 分支里**覆盖上一条 AI 消息** ——
 * 表现为「AI 消息经常丢失」，数据库里只留一条 id='' 的记录。
 *
 * 该 bug 已修（客户端 generateId + 服务端 uuid 兜底），所以 id='' 的行
 * 都是修复前产生的孤立残留：它们不属于任何一次真实回答，也不会再被更新。
 *
 * 用法
 * ----
 *   node scripts/cleanup-empty-id.mjs          # 只查看（默认，安全）
 *   node scripts/cleanup-empty-id.mjs --apply  # 真正删除
 *
 * 默认只读是刻意的：删除是不可逆的，必须由人明确确认一次。
 */
import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'

// scripts/db.mjs 里已有 .env 加载逻辑，这里复用同样的做法，
// 保证脚本在 Windows 上也能拿到 directUrl（迁移/写入需要非连接池地址）。
function loadEnv() {
  for (const file of ['.env.local', '.env']) {
    try {
      const raw = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
      for (const line of raw.split(/\r?\n/)) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
        if (!m) continue
        const key = m[1]
        if (process.env[key] !== undefined) continue
        let value = m[2].trim()
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1)
        }
        process.env[key] = value
      }
    } catch {
      // 文件不存在就跳过
    }
  }
}

loadEnv()

const apply = process.argv.includes('--apply')

// 写入操作走非连接池地址，避免 pgbouncer 对事务的影响
const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_PRISMA_URL
if (!url) {
  console.error('缺少 POSTGRES_URL_NON_POOLING / POSTGRES_PRISMA_URL，无法连接数据库')
  process.exit(1)
}

const prisma = new PrismaClient({ datasources: { db: { url } } })

try {
  const emptyIdRows = await prisma.message.findMany({
    where: { id: '' },
    select: {
      id: true,
      chatId: true,
      role: true,
      content: true,
      createdAt: true,
      chat: { select: { title: true, userId: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  if (emptyIdRows.length === 0) {
    console.log('✓ 没有 id = \'\' 的残留行，无需清理。')
    process.exit(0)
  }

  console.log(`发现 ${emptyIdRows.length} 条 id = '' 的残留行：\n`)
  for (const row of emptyIdRows) {
    console.log(`  chatId   : ${row.chatId}`)
    console.log(`  会话标题 : ${row.chat?.title ?? '(未知)'}`)
    console.log(`  角色     : ${row.role}`)
    console.log(`  内容长度 : ${row.content.length} 字符`)
    console.log(`  预览     : ${JSON.stringify(row.content.slice(0, 60))}`)
    console.log(`  创建时间 : ${row.createdAt.toISOString()}`)
    console.log('')
  }

  if (!apply) {
    console.log('（这是只读预览。确认无误后加 --apply 参数真正删除：')
    console.log('   node scripts/cleanup-empty-id.mjs --apply ）')
    process.exit(0)
  }

  const deleted = await prisma.message.deleteMany({ where: { id: '' } })
  console.log(`✓ 已删除 ${deleted.count} 条 id = '' 的残留行。`)
  console.log('')
  console.log('注意：这些行被删除后，对应会话的消息数与之前相比会少几条 ——')
  console.log('      减少的正是"被反复覆盖、只剩最后一份内容"的那些记录，属于预期。')
} catch (err) {
  console.error('清理失败：', err instanceof Error ? err.message : err)
  process.exitCode = 1
} finally {
  await prisma.$disconnect()
}
