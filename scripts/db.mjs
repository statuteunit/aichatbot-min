#!/usr/bin/env node
// scripts/db.mjs
// 数据库同步工作流（人工触发，Agent 不得调用）
//
//   node scripts/db.mjs            交互式菜单
//   node scripts/db.mjs sync       路径1：只改了业务代码 → 仅 prisma generate（不连数据库）
//   node scripts/db.mjs migrate    路径2A：改了 schema → 新建迁移并应用（migrate dev）
//   node scripts/db.mjs deploy     路径2B：把已提交迁移推到远程（migrate deploy）
//   node scripts/db.mjs status     只查看迁移状态（只读）

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA = path.join(ROOT, 'prisma', 'schema.prisma')
const HASH_FILE = path.join(ROOT, 'data', '.prisma-schema-hash')
const require = createRequire(import.meta.url)

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
}
const ok = (m) => console.log(`${c.green}✓${c.reset} ${m}`)
const warn = (m) => console.log(`${c.yellow}!${c.reset} ${m}`)
const fail = (m) => console.log(`${c.red}✗${c.reset} ${m}`)
const step = (m) => console.log(`${c.cyan}▸${c.reset} ${m}`)

// ---------------------------------------------------------------------------
// 定位 Prisma CLI
//
// 关键：不要 spawn node_modules/.bin/prisma.cmd。
// Node 18.20.2 / 20.12.2 / 21.7.3 起（CVE-2024-27980），shell:false 时
// spawn 一个 .cmd/.bat 会直接抛 EINVAL。这里改为用 process.execPath
// 直接执行 .cmd 转发器内部实际调用的那个 JS 入口。
// ---------------------------------------------------------------------------
function resolvePrismaCli() {
  try {
    // require.resolve('prisma') 走 package.json 的 "require" export 条件
    // → ./build/index.js（与 .cmd 第 8 行调用的文件相同）
    return require.resolve('prisma')
  } catch {
    try {
      const pkg = require.resolve('prisma/package.json')
      return path.join(path.dirname(pkg), 'build', 'index.js')
    } catch {
      return null
    }
  }
}

const PRISMA_CLI = resolvePrismaCli()

function readEnvFile() {
  const out = {}
  const file = path.join(ROOT, '.env')
  if (!existsSync(file)) return out
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

function fullEnv() {
  return { ...readEnvFile(), ...process.env }
}

function requireEnv() {
  const env = fullEnv()
  const missing = ['POSTGRES_PRISMA_URL', 'POSTGRES_URL_NON_POOLING'].filter((k) => !env[k])
  if (missing.length) {
    fail(`缺少环境变量：${missing.join(', ')}（请检查 .env）`)
    process.exit(1)
  }
  return env
}

function schemaHash() {
  return createHash('sha256').update(readFileSync(SCHEMA)).digest('hex')
}

function lastAppliedHash() {
  return existsSync(HASH_FILE) ? readFileSync(HASH_FILE, 'utf8').trim() : null
}

function rememberSchemaHash() {
  mkdirSync(path.dirname(HASH_FILE), { recursive: true })
  writeFileSync(HASH_FILE, schemaHash(), 'utf8')
}

function describeSchemaDrift() {
  const current = schemaHash()
  const last = lastAppliedHash()
  if (!last) {
    warn('还没有同步记录（data/.prisma-schema-hash 不存在）——这次会被当作首次同步')
    return { changed: true, firstTime: true }
  }
  return { changed: current !== last, firstTime: false }
}

/** 串行执行 prisma 命令；Windows 下用 node 直跑 JS 入口，绕开 .cmd 限制 */
function run(args, env) {
  return new Promise((resolve, reject) => {
    step(`prisma ${args.join(' ')}`)

    let file
    let fileArgs

    if (PRISMA_CLI) {
      file = process.execPath
      fileArgs = [PRISMA_CLI, ...args]
    } else {
      // 退路：找不到 JS 入口时才用 .bin 转发器，此时必须 shell:true
      warn('未能解析 prisma JS 入口，回退到 .bin 转发器（shell: true）')
      file = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'prisma.cmd' : 'prisma')
      fileArgs = args
    }

    const child = spawn(file, fileArgs, {
      cwd: ROOT,
      stdio: 'inherit',
      env,
      shell: !PRISMA_CLI && process.platform === 'win32',
    })

    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`prisma ${args.join(' ')} 退出码 ${code}`)),
    )
  })
}

async function runStatus(env) {
  try {
    await run(['migrate', 'status'], env)
    return true
  } catch (err) {
    warn(`migrate status 未能完成：${err.message}`)
    warn('若上面出现 P1001 / Can\'t reach database server，才是真正的连接问题。')
    warn('请检查 .env 里的 POSTGRES_URL_NON_POOLING（迁移走直连，不能带 pgbouncer=true）。')
    return false
  }
}

// ---------------------------------------------------------------- 路径 1

async function cmdSync(env) {
  const { changed } = describeSchemaDrift()
  if (changed) {
    warn('检测到 prisma/schema.prisma 相对上次同步已发生变化。')
    warn('如果你改了表结构，只做 generate 会让本地 Client 与远程库不一致。')
    warn(`如果确实只是改了业务代码，请忽略本提示；否则改用：${c.bold}pnpm run db:migrate -- --name <名字>${c.reset}`)
    console.log('')
  }
  await run(['generate'], env)
  ok('Prisma Client 已重新生成（未连接数据库，远程库未发生任何变化）')
}

// ---------------------------------------------------------------- 路径 2A

async function cmdMigrate(env, name) {
  requireEnv()
  if (!name) {
    fail('缺少迁移名。用法：pnpm run db:migrate -- --name add_chat_mode')
    process.exit(1)
  }

  const { changed } = describeSchemaDrift()
  if (!changed) {
    warn('schema.prisma 与上次同步记录相比没有变化。')
    warn('migrate dev 会生成一个「空迁移」。如果只是想应用已有迁移，请用：pnpm run db:deploy')
    console.log('')
  }

  await runStatus(env)

  await run(['migrate', 'dev', '--name', name], env)
  rememberSchemaHash() // migrate dev 内部已执行 generate，无需再跑一次
  ok('结构迁移已创建并应用，Prisma Client 已同步生成')
}

// ---------------------------------------------------------------- 路径 2B

async function cmdDeploy(env, { force = false } = {}) {
  requireEnv()

  const { changed } = describeSchemaDrift()
  if (changed) {
    warn('注意：schema.prisma 比上次同步记录更新。')
    warn('deploy 只应用 prisma/migrations/ 里已存在的迁移，不会读取 schema 的新改动。')
    warn(`若要为新结构生成迁移，请改用：${c.bold}pnpm run db:migrate -- --name <名字>${c.reset}`)
    console.log('')
  }

  await runStatus(env)

  if (!force) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = (await rl.question(`\n${c.yellow}以上将应用到远程数据库，确认执行 migrate deploy？[y/N] ${c.reset}`)).trim().toLowerCase()
    rl.close()
    if (answer !== 'y' && answer !== 'yes') {
      fail('已取消，远程库未做任何改动')
      process.exit(1)
    }
  }

  await run(['migrate', 'deploy'], env)
  rememberSchemaHash()
  ok('迁移已应用到远程数据库')
}

// ---------------------------------------------------------------- 入口

const argv = process.argv.slice(2)
const command = argv[0]
const nameIndex = argv.indexOf('--name')
const name = nameIndex >= 0 ? argv[nameIndex + 1] : undefined
const force = argv.includes('--yes')

const HELP = `
${c.bold}数据库同步工作流${c.reset}

  ${c.bold}1) sync${c.reset}     只改了业务逻辑，没动表结构
               → 只执行 prisma generate，不连接数据库，远程库零风险
               ${c.dim}pnpm run db:sync${c.reset}

  ${c.bold}2) migrate${c.reset}  改了 schema.prisma 的表结构
               → prisma migrate dev --name <名字>：生成迁移文件 + 应用到远程 + 重新 generate
               ${c.dim}pnpm run db:migrate -- --name add_chat_mode${c.reset}

  ${c.bold}3) deploy${c.reset}   结构和迁移文件都已经提交好了，只把待应用的迁移推给远程
               → prisma migrate deploy（生产安全，不会新建迁移）
               ${c.dim}pnpm run db:deploy${c.reset}

  ${c.bold}4) status${c.reset}   只查看迁移状态，不做任何改动
  ${c.dim}pnpm run db            交互式菜单${c.reset}
`

async function main() {
  // CLI 解析自检：把「脚本自己起不来」和「数据库连不上」彻底分开
  if (!PRISMA_CLI) {
    warn('未能解析到 prisma CLI 的 JS 入口，将回退到 .bin 转发器。')
  }

  const env = fullEnv()

  if (!command) {
    console.log(HELP)
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const pick = (await rl.question('请选择 [1] sync  [2] migrate  [3] deploy  [4] status : ')).trim()
    rl.close()
    if (pick === '1') return cmdSync(env)
    if (pick === '2') {
      const rl2 = createInterface({ input: process.stdin, output: process.stdout })
      const n = (await rl2.question('迁移名（snake_case，如 add_chat_mode）: ')).trim()
      rl2.close()
      return cmdMigrate(env, n)
    }
    if (pick === '3') return cmdDeploy(env)
    if (pick === '4') return void (await runStatus(env))
    fail('无效选择')
    process.exit(1)
  }

  if (command === '--help' || command === '-h' || command === 'help') return void console.log(HELP)
  if (command === 'sync') return cmdSync(env)
  if (command === 'migrate') return cmdMigrate(env, name)
  if (command === 'deploy') return cmdDeploy(env, { force })
  if (command === 'status') return void (await runStatus(env))

  fail(`未知命令：${command}`)
  console.log(HELP)
  process.exit(1)
}

main().catch((err) => {
  console.error(`\n${c.red}失败：${c.reset}${err.message}`)
  process.exit(1)
})