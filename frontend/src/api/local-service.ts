import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  commitModule,
  currentVersion,
  listRows,
  resetRows,
} from '@/data/local-store'
import {
  FLAG_RULE,
  RULE_VERSION,
  metricValue,
  settleRow,
  settledFlags,
} from '@/data/settlement'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  TodoItem,
} from '@/data/types'

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

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 状态流转 = 一次结算：校验 → 事务提交（跨终端加锁 + 版本乐观锁）→ 按统一口径打终态戳记并一次落库。
// 两个终端同时结算时版本/锁只放行一个；写一半抛错则整单回滚，行不会停留在新旧口径之间。
export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const currentRow = rows.find((row) => Number(row.id) === id)
  if (!currentRow) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  if (String(currentRow.status) === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }

  const expectedVersion = currentVersion()
  const commit = commitModule(expectedVersion, key, (latest) => {
    const index = latest.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      throw new Error('结算期间记录消失')
    }
    // 结算标记完全由「目标状态」经统一口径推导：完成办结会清掉旧未结/旧异常，作废只在状态属异常态时计异常。
    latest[index] = settleRow(meta, { ...latest[index], status: target }, true)
    return latest
  })

  if (!commit.ok) {
    return { ok: false, message: commit.error.message }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

// 导出直接读最近一次落库的同一批数据（其它终端结算后缓存已失效），
// 并把「是否未结/是否异常/结算口径」一并带出，保证导出与明细、汇总同口径、不滞后。
export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态', '是否未结', '是否异常', '结算口径']
  const lines = [header.map(csvCell).join(',')]
  for (const row of listRows(key)) {
    const flags = settledFlags(row)
    const rule = row[FLAG_RULE] === undefined ? '历史口径' : String(row[FLAG_RULE])
    lines.push(
      [
        row.id,
        ...meta.fields.map((field) => row[field] ?? ''),
        row.status,
        flags.pending ? '未结' : '已结',
        flags.abnormal ? '异常' : '正常',
        rule,
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
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

// 列表页指标卡：与概览、导出共用同一套取数口径（总量 + 登记的状态指标）。
export function moduleStats(
  key: string,
): { label: string; value: number | null }[] {
  const meta = moduleMeta(key)
  const rows = listRows(key)
  return meta.metrics.map((label, index) => ({ label, value: metricValue(meta, index, rows) }))
}

function overviewFrom(rows: Record<string, EntryRow[]>): OverviewResult {
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      // 数的是「已结算标记」：完成或作废后旧值不会残留；历史行保留其当时口径的标记，不被新口径重算。
      pending: entries.filter((row) => settledFlags(row).pending).length,
      abnormal: entries.filter((row) => settledFlags(row).abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

export function loadOverview(): OverviewResult {
  return overviewFrom(allRows())
}

// 关联业务面的待办清单：与总览取自同一批数据（同一次 allRows 快照），不在页面侧另算。
function todosFrom(rows: Record<string, EntryRow[]>): TodoItem[] {
  const items: TodoItem[] = []
  for (const meta of MODULE_BY_KEY.values()) {
    for (const row of rows[meta.key] ?? []) {
      if (!settledFlags(row).pending) {
        continue
      }
      items.push({
        moduleKey: meta.key,
        moduleName: meta.name,
        id: Number(row.id),
        status: String(row.status),
        title: String(row[meta.fields[0]] ?? row.id),
      })
    }
  }
  return items
}

// 一次读取，同时产出总览与待办：两者天然来自同一批已结算数据。
export function loadDashboard(): {
  overview: OverviewResult
  todos: TodoItem[]
  ruleVersion: string
  legacy: boolean
} {
  const rows = allRows()
  const legacy = Object.values(rows)
    .flat()
    .some((row) => row[FLAG_RULE] === undefined)
  return { overview: overviewFrom(rows), todos: todosFrom(rows), ruleVersion: RULE_VERSION, legacy }
}
