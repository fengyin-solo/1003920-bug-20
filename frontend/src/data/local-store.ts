import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'geohazard-monitor-prevention:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && Boolean(window.localStorage)
}

// 非浏览器环境（类型检查、单测等）没有 localStorage，用内存兜底。
let memoryFallback: Record<string, EntryRow[]> | null = null

function seedRows(): Record<string, EntryRow[]> {
  return clone(SEED_ROWS)
}

// 每次取数都直接读持久化快照，不在内存里另存一份旧账：
// 总览、列表、待办清单、导出看到的都是同一批数据，别的标签页刚落库的改动也能立刻读到。
export function allRows(): Record<string, EntryRow[]> {
  if (!hasStorage()) {
    if (memoryFallback === null) {
      memoryFallback = seedRows()
    }
    return memoryFallback
  }
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(STORAGE_KEY)
  } catch {
    // 存储被禁用时读也兜底，页面不崩，按种子数据展示。
    return seedRows()
  }
  if (!raw) {
    const seeded = seedRows()
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    } catch {
      // 播种写不进去就算了，本次仍按种子数据返回。
    }
    return seeded
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...seedRows(), ...parsed }
  } catch {
    const seeded = seedRows()
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    } catch {
      // 同上：存储不可用时只返回，不强行落库。
    }
    return seeded
  }
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

// 唯一落库入口：整个数据集一次写入。先写 localStorage，写成功才算数；
// 写不进去返回 false，内存里也不留半截数据，调用方按失败处理，等于整体回滚。
export function persistAll(next: Record<string, EntryRow[]>): boolean {
  if (!hasStorage()) {
    memoryFallback = next
    return true
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    return true
  } catch {
    return false
  }
}

export function saveRows(key: string, rows: EntryRow[]): boolean {
  return persistAll({ ...allRows(), [key]: rows })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
