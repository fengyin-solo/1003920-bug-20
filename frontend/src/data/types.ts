/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  // 结算口径（RULE_VERSION 版）：
  // terminalStatuses 终态——含正常办结与作废/驳回/误报等终止态，终态不再计入未结事项；
  // abnormalStatuses 异常态——按状态本身判定，与执行了哪个动作无关，作废但非异常的状态不在其中；
  // metricStatuses 与 metrics 一一对应，首项为 null 表示取登记总量；
  // 字符串按该状态计数；字符串数组表示命中其中任一状态即计数；其余 null 表示该指标无法由状态推出（页面展示 —）。
  terminalStatuses: string[]
  abnormalStatuses: string[]
  metricStatuses: (string | string[] | null)[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// 待办事项：与运营概览取自同一批已结算数据，不在页面侧另算口径。
export type TodoItem = {
  moduleKey: string
  moduleName: string
  id: number
  status: string
  title: string
}

// localStorage 里落库的信封：数据本体 + 单调递增版本号。
// 每次成功结算版本号 +1；并发结算用它做乐观锁，版本对不上则整单失败、回滚。
export type StoreEnvelope = {
  version: number
  ruleVersion: string
  rows: Record<string, EntryRow[]>
}
