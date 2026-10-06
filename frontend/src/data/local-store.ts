import { MODULE_BY_KEY } from './modules'
import { SEED_ROWS } from './seed'
import { FLAG_RULE, RULE_VERSION, settleRow } from './settlement'
import type { EntryRow, StoreEnvelope } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// 落库结构是「信封」：版本号 + 口径版本 + 数据本体，整体一次 setItem 原子写入。
const STORAGE_KEY = 'geohazard-monitor-prevention:entries'
// 跨终端（多标签页）结算互斥锁：同一时刻只允许一个终端进入结算。
const LOCK_KEY = 'geohazard-monitor-prevention:settle-lock'
// 锁的最长持有时间：持有者崩溃时，其他终端可在超时后接管。
const LOCK_TTL_MS = 10_000

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 播种即按当前口径完成首次结算（演示数据代表「当前班次」的结算结果）；
// 真实历史数据（旧版浏览器里无信封、无结算戳记）走迁移路径，戳记缺失即按当时口径保留，不重算。
function seedEnvelope(): StoreEnvelope {
  const rows: Record<string, EntryRow[]> = {}
  for (const [key, seedRows] of Object.entries(SEED_ROWS)) {
    const meta = MODULE_BY_KEY.get(key)
    rows[key] = meta
      ? seedRows.map((row) => settleRow(meta, row, true))
      : clone(seedRows)
  }
  return { version: 1, ruleVersion: RULE_VERSION, rows }
}

function isEnvelope(value: unknown): value is StoreEnvelope {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return typeof candidate.version === 'number' && typeof candidate.rows === 'object'
}

// 旧版本直接平铺存 Record<string, EntryRow[]>：包进信封但不补算戳记，
// 这些行没有结算口径戳记，读取时按行内旧标记展示——历史班次按当时口径保留。
function migrateLegacy(parsed: Record<string, EntryRow[]>): StoreEnvelope {
  return { version: 1, ruleVersion: 'legacy', rows: clone(parsed) }
}

function readStorage(): StoreEnvelope {
  const fallback = seedEnvelope()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    persist(fallback)
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (isEnvelope(parsed)) {
      // 新版本模块的种子行补齐：旧信封里缺少的模块按当前口径播种，不动既有模块。
      const rows = { ...seedEnvelope().rows, ...parsed.rows }
      return { ...parsed, rows }
    }
    const migrated = migrateLegacy(parsed as Record<string, EntryRow[]>)
    persist(migrated)
    return migrated
  } catch {
    // 数据损坏时不覆盖：回退到示例数据仅供本次会话使用，避免把用户数据写坏。
    return fallback
  }
}

function persist(envelope: StoreEnvelope): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  // 单次 setItem 由浏览器保证原子性：要么完整写入新版本，要么保留旧版本，不会留下写一半的数据。
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope))
}

let cache: StoreEnvelope | null = null

function snapshot(): StoreEnvelope {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  return snapshot().rows
}

export function listRows(key: string): EntryRow[] {
  return snapshot().rows[key] ?? []
}

export function currentVersion(): number {
  return snapshot().version
}

export function currentRuleVersion(): string {
  return snapshot().ruleVersion
}

export function storageKey(): string {
  return STORAGE_KEY
}

function lockOwnerId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

type LockInfo = { owner: string; at: number }

// 尝试获取跨终端结算锁。锁存在且未过期时，其他终端必须等待——两个终端同时结算只有一个能进。
function acquireLock(): { ok: true; owner: string } | { ok: false; message: string } {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { ok: true, owner: 'noop' }
  }
  const owner = lockOwnerId()
  try {
    const raw = window.localStorage.getItem(LOCK_KEY)
    if (raw) {
      const lock = JSON.parse(raw) as LockInfo
      const fresh = Date.now() - lock.at < LOCK_TTL_MS
      if (fresh) {
        return { ok: false, message: '另一终端正在结算，请稍后重试' }
      }
    }
    window.localStorage.setItem(LOCK_KEY, JSON.stringify({ owner, at: Date.now() }))
    // 再读一次确认：两个终端同时抢锁时，只允许最后确认仍是自己持有的那个继续。
    const confirmed = window.localStorage.getItem(LOCK_KEY)
    if (!confirmed || (JSON.parse(confirmed) as LockInfo).owner !== owner) {
      return { ok: false, message: '结算冲突，仅一个请求能够成功，请刷新后重试' }
    }
    return { ok: true, owner }
  } catch {
    return { ok: false, message: '结算锁获取失败，请稍后重试' }
  }
}

function releaseLock(owner: string): void {
  if (typeof window === 'undefined' || !window.localStorage || owner === 'noop') {
    return
  }
  try {
    const raw = window.localStorage.getItem(LOCK_KEY)
    if (raw && (JSON.parse(raw) as LockInfo).owner === owner) {
      window.localStorage.removeItem(LOCK_KEY)
    }
  } catch {
    // 锁状态异常时留给 TTL 兜底，不强删，避免误释放其他终端的锁。
  }
}

export type CommitError = { message: string }

// 事务式结算：取锁 → 重读最新版本 → 基于最新数据计算 → 版本号 +1 原子落库 → 回读校验。
// 任一步失败都不产生半成品：内存改动与已落库数据保持一致，写一半时整单回滚。
export function commitSettlement(
  expectedVersion: number,
  mutate: (rows: Record<string, EntryRow[]>) => Record<string, EntryRow[]>,
): { ok: true } | { ok: false; error: CommitError } {
  const lock = acquireLock()
  if (!lock.ok) {
    return { ok: false, error: { message: lock.message } }
  }
  const owner = lock.owner
  try {
    // 拿锁后必须重读：锁等待期间别的终端可能已经结算过，缓存版本不再可信。
    cache = readStorage()
    const before = snapshot()
    if (before.version !== expectedVersion) {
      return {
        ok: false,
        error: { message: '数据已被其他终端结算，请刷新后再操作' },
      }
    }

    let nextRows: Record<string, EntryRow[]>
    try {
      nextRows = mutate(clone(before.rows))
    } catch {
      return { ok: false, error: { message: '结算处理失败，已回滚，数据未变更' } }
    }

    const nextEnvelope: StoreEnvelope = {
      version: before.version + 1,
      ruleVersion: RULE_VERSION,
      rows: nextRows,
    }

    try {
      persist(nextEnvelope)
    } catch {
      // 写失败（如配额/隐私模式）：保留旧信封，内存缓存也不切换，等价整单回滚。
      return { ok: false, error: { message: '落库失败，已回滚，数据未变更' } }
    }

    // 回读校验：确认落库的就是本次信封（极端情况下存储被拦截/替换时不提交内存状态）。
    const written = readStorage()
    if (written.version !== nextEnvelope.version) {
      cache = before
      return { ok: false, error: { message: '结算结果校验失败，已回滚，数据未变更' } }
    }
    cache = written
    return { ok: true }
  } finally {
    releaseLock(owner)
  }
}

// 仅在当前版本上修改单个模块的便捷封装。
export function commitModule(
  expectedVersion: number,
  key: string,
  updater: (rows: EntryRow[]) => EntryRow[],
): { ok: true } | { ok: false; error: CommitError } {
  return commitSettlement(expectedVersion, (rows) => ({
    ...rows,
    [key]: updater(rows[key] ?? []),
  }))
}

export function resetRows(key: string): EntryRow[] {
  const meta = MODULE_BY_KEY.get(key)
  const rows = clone(SEED_ROWS[key] ?? []).map((row) =>
    meta ? settleRow(meta, row, true) : row,
  )
  commitModule(currentVersion(), key, () => rows)
  return listRows(key)
}

// 其他终端落库后（storage 事件）废弃本地缓存：之后所有取数、导出都读到最新批次，
// 重复刷新只是重新读取同一批数据，不会产生新结算、不会让汇总累加。
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) {
      cache = null
    }
  })
}

export function hasLegacyRows(): boolean {
  return Object.values(snapshot().rows)
    .flat()
    .some((row) => row[FLAG_RULE] === undefined)
}
