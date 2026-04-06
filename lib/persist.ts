import 'server-only'
import fs from 'fs'
import { promises as fsp } from 'fs'
import path from 'path'
import type { Message } from '@/types/chat'

export interface PersistChat {
  id: string
  title: string
  createdAt: Date
  updatedAt: Date
  model: string
}
export interface PersistShape {
  chats: PersistChat[]
  messages: Record<string, Message[]>
}

// nodeJS进程目录，根目录
const DATA_DIR = path.join(process.cwd(), 'data')
const STORE_FILE = path.join(DATA_DIR, 'store.json')
const TMP_FILE = path.join(DATA_DIR, 'store.tmp.json')

function ensureDirSync(dir: string) {
  if (!fs.existsSync(dir)) {
    // 目录不存在
    fs.mkdirSync(dir, { recursive: true })
  }
}

export function readStoreSync(): PersistShape {
  ensureDirSync(DATA_DIR)
  if (!fs.existsSync(STORE_FILE)) {
    // 文件不存在
    // JSON不做过滤，每层缩进两个空格
    fs.writeFileSync(STORE_FILE, JSON.stringify({ chats: [], messages: {} }, null, 2), 'utf-8')
    return { chats: [], messages: {} }
  }
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as PersistShape
    parsed.chats ||= []
    parsed.messages ||= {}
    return parsed
  } catch (e) {
    console.error('读取文件失败', e)
    // fs.writeFileSync(STORE_FILE, JSON.stringify({ chats: [], messages: {} }, null, 2), 'utf-8')
    return { chats: [], messages: {} }
  }
}

export async function writeStore(data: PersistShape): Promise<void> {
  ensureDirSync(DATA_DIR)
  // Promise 版，支持 async/await
  await fsp.writeFile(TMP_FILE, JSON.stringify(data, null, 2), 'utf-8')
  await fsp.rename(TMP_FILE, STORE_FILE)
}