import type { EntryRow, ModuleMeta } from './types'

// 当前结算口径版本。历史班次按「当时的口径」展示：已结算行携带结算时的口径版本，
// 口径升级后只对新发生的结算生效，绝不回头重算历史行。
export const RULE_VERSION = '2026-10-01'

// 行上记录终态标记与结算口径的字段（旧版本浏览器数据里可能没有）。
export const FLAG_PENDING = '__settledPending'
export const FLAG_ABNORMAL = '__settledAbnormal'
export const FLAG_RULE = '__settledRule'

export type SettledFlags = { pending: boolean; abnormal: boolean }

function hitsMetric(row: EntryRow, spec: string | string[] | null): boolean {
  if (spec === null) {
    return false
  }
  const status = String(row.status)
  return Array.isArray(spec) ? spec.includes(status) : status === spec
}

// 按模块口径，由「当前状态」推出终态标记。注意：异常不再按执行的动作动词判定，
// 作废类终态（已核销/已废止/已取消/已注销/误报…）是否异常只看状态是否登记在 abnormalStatuses 里。
export function settleStatus(meta: ModuleMeta, status: string): SettledFlags {
  const pending = !meta.terminalStatuses.includes(status)
  const abnormal = meta.abnormalStatuses.includes(status)
  return { pending, abnormal }
}

// 给一行打结算戳记。历史行（已带旧口径戳记）默认不重算；仅在 force 或首次结算时落新戳。
export function settleRow(meta: ModuleMeta, row: EntryRow, force = false): EntryRow {
  if (!force && row[FLAG_RULE] !== undefined) {
    return row
  }
  const { pending, abnormal } = settleStatus(meta, String(row.status))
  return {
    ...row,
    pending,
    abnormal,
    [FLAG_PENDING]: pending,
    [FLAG_ABNORMAL]: abnormal,
    [FLAG_RULE]: RULE_VERSION,
  }
}

// 读取一行的已结算标记。未结算的历史行回退到行内 pending/abnormal 字段（当时口径的结果），
// 绝不按新口径替它重算。
export function settledFlags(row: EntryRow): SettledFlags {
  if (row[FLAG_PENDING] === undefined) {
    return { pending: Boolean(row.pending), abnormal: Boolean(row.abnormal) }
  }
  return {
    pending: Boolean(row[FLAG_PENDING]),
    abnormal: Boolean(row[FLAG_ABNORMAL]),
  }
}

export function settledRule(row: EntryRow): string | null {
  const rule = row[FLAG_RULE]
  return rule === undefined ? null : String(rule)
}

// 模块指标卡取数：总量取登记数；状态指标数同一批已结算/当前行，按登记的状态口径计数；
// spec 为 null 的派生指标（累计降雨量、通过率等）无法由状态推出，返回 null，页面展示 —。
export function metricValue(meta: ModuleMeta, index: number, rows: EntryRow[]): number | null {
  const spec = meta.metricStatuses[index] ?? null
  if (index === 0 || spec === null) {
    return index === 0 ? rows.length : null
  }
  return rows.filter((row) => hitsMetric(row, spec)).length
}
