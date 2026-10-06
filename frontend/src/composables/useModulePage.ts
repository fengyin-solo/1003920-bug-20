import { onMounted, onUnmounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  moduleStats,
  runAction as applyAction,
} from '@/api/local-service'
import { listRows, storageKey } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

// 各业务模块列表页的统一入口：明细、指标卡、状态图例、动作结算与导出全部走同一数据服务，
// 页面不再各自维护口径（此前指标卡在页面里写死为 0，是明细与汇总对不上的直接原因之一）。
export function useModulePage(key: string) {
  const meta = moduleMeta(key)
  const columns = meta.fields
  const actions = meta.actions
  const statuses = meta.statuses

  const rows = ref<EntryRow[]>([])
  const total = ref(0)
  const errorMessage = ref('')
  const filters = ref<Record<string, string>>({})
  const filterFields = columns.slice(0, 3)

  // 指标卡与状态图例都按「全量已落库数据」计数，不受查询条件影响；表格明细才是过滤后的结果。
  const stats = ref<{ label: string; value: number | null }[]>([])
  const statusSummary = ref<{ status: string; count: number }[]>([])

  function rebuildSummary() {
    const all = listRows(meta.key)
    statusSummary.value = statuses.map((status) => ({
      status,
      count: all.filter((row) => String(row.status) === status).length,
    }))
  }

  function reload() {
    errorMessage.value = ''
    try {
      stats.value = moduleStats(meta.key)
      rebuildSummary()
      const payload = listEntries(meta.key, filters.value)
      rows.value = payload.items
      total.value = payload.total
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : `${meta.name}列表读取失败`
    }
  }

  function resetFilters() {
    filters.value = {}
    reload()
  }

  function exportRows() {
    try {
      downloadEntries(meta.key)
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : `${meta.name}导出失败`
    }
  }

  function openCreate() {
    errorMessage.value = `${meta.entity}登记入口尚未接入审批流`
  }

  function runAction(action: string, row: EntryRow) {
    errorMessage.value = ''
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    reload()
  }

  // 其他终端完成结算并落库后，本页自动重读同一批新数据；重复触发只读数，不会产生新结算。
  function onStorage(event: StorageEvent) {
    if (event.key === storageKey() || event.key === null) {
      reload()
    }
  }

  onMounted(() => {
    reload()
    window.addEventListener('storage', onStorage)
  })

  onUnmounted(() => window.removeEventListener('storage', onStorage))

  return {
    meta,
    columns,
    actions,
    statuses,
    rows,
    total,
    errorMessage,
    filters,
    filterFields,
    stats,
    statusSummary,
    reload,
    resetFilters,
    exportRows,
    openCreate,
    runAction,
  }
}
