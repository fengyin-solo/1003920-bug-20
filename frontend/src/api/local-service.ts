import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, persistAll, resetRows } from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  ModulePageResult,
  ModuleStat,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

// 未结/异常只按落库在记录上的标记统计：历史数据保持当时结算的结果，不按新口径重算。
function summarizeRows(meta: ModuleMeta, rows: EntryRow[]): ModuleStat {
  return {
    created: rows.length,
    pending: rows.filter((row) => row.pending).length,
    abnormal: rows.filter((row) => row.abnormal).length,
    byStatus: meta.statuses.map((status) => ({
      status,
      count: rows.filter((row) => String(row.status) === status).length,
    })),
  }
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 列表页一次取数：表格明细和汇总卡片来自同一批快照；筛选只影响明细，不影响汇总口径。
export function loadModulePage(key: string, filters: Record<string, string> = {}): ModulePageResult {
  const meta = moduleMeta(key)
  const rows = listRows(key)
  const matched = filterRows(rows, filters)
  return {
    items: matched,
    total: matched.length,
    page: 1,
    size: matched.length,
    summary: summarizeRows(meta, rows),
  }
}

// 结算排队锁：两个终端（标签页）同时结算时，拿到锁的先落库，
// 后进来的在锁内重读到最新状态，自然只有第一个请求成功。
const SETTLE_LOCK_NAME = 'geohazard-monitor-prevention:settle'

type LockManagerLike = {
  request: <T>(name: string, callback: () => T | Promise<T>) => Promise<T>
}

function settleLock(): LockManagerLike | undefined {
  if (typeof navigator === 'undefined') {
    return undefined
  }
  return (navigator as Navigator & { locks?: LockManagerLike }).locks
}

function withSettleLock<T>(task: () => T): Promise<T> {
  const locks = settleLock()
  if (!locks) {
    return Promise.resolve().then(task)
  }
  return locks.request(SETTLE_LOCK_NAME, task)
}

export async function runAction(
  key: string,
  id: number,
  action: string,
  expectedStatus?: string,
): Promise<ActionResult> {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  return withSettleLock(() => {
    // 锁内重读最新一批数据，基于它校验和结算，避免照着旧快照改。
    const snapshot = allRows()
    const rows = snapshot[key] ?? []
    const index = rows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
    }
    const current = String(rows[index].status)
    if (expectedStatus !== undefined && current !== expectedStatus) {
      return { ok: false, message: `这条${meta.entity}已被其他终端改成「${current}」，请刷新后再操作` }
    }
    if (current === target) {
      return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
    }
    // 统一口径：终态以模块登记的 terminalStatuses 为准，状态、未结、异常一次算清。
    const updated: EntryRow = {
      ...rows[index],
      status: target,
      pending: !meta.terminalStatuses.includes(target),
      abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
    }
    const nextRows = [...rows]
    nextRows[index] = updated
    // 算完后整个数据集一次落库；写不进去就整体回滚，不留半截。
    if (!persistAll({ ...snapshot, [key]: nextRows })) {
      return { ok: false, message: '本地存储写入失败，本次修改已回滚' }
    }
    return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
  })
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

// 总览一次取数：卡片、分模块汇总、待办清单全部从同一批快照生成，
// 重复刷新只是按落库标记重算，不会累加。
export function loadOverview(): OverviewResult {
  const snapshot = allRows()
  const metas = [...MODULE_BY_KEY.values()]
  const modules = metas.map((meta) => {
    const stat = summarizeRows(meta, snapshot[meta.key] ?? [])
    return {
      key: meta.key,
      name: meta.name,
      created: stat.created,
      pending: stat.pending,
      abnormal: stat.abnormal,
    }
  })
  const todos = metas.flatMap((meta) =>
    (snapshot[meta.key] ?? [])
      .filter((row) => row.pending)
      .map((row) => ({
        module: meta.name,
        id: Number(row.id),
        label: String(row[meta.fields[0]] ?? row.id),
        status: String(row.status),
      })),
  )
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules, todos }
}
