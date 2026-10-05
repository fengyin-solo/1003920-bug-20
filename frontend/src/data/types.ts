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
  /** 终态：落到这些状态就算办结（或无需再跟进），不再计入未结事项。 */
  terminalStatuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

/** 单个模块的汇总：总量 / 未结 / 异常，外加按状态分布，全部来自同一批数据。 */
export type ModuleStat = {
  created: number
  pending: number
  abnormal: number
  byStatus: { status: string; count: number }[]
}

export type ModulePageResult = PageResult & {
  summary: ModuleStat
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type TodoItem = {
  module: string
  id: number
  label: string
  status: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { key: string; name: string; created: number; pending: number; abnormal: number }[]
  /** 待办清单：和上面的卡片、分模块汇总从同一批快照生成，重复刷新不会累加。 */
  todos: TodoItem[]
}
