<template>
  <section class="page" data-module="tilt">
    <header class="page-head">
      <div>
        <h2>倾斜监测管理</h2>
        <p class="page-desc">维护倾斜记录，围绕记录编号、测点编号、观测方向、倾斜角度做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记倾斜记录</button>
        <button class="btn" type="button" @click="exportRows">导出倾斜监测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无倾斜监测数据，可先登记倾斜记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条倾斜监测记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  loadModulePage,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow, ModuleStat } from '@/data/types'

const meta = moduleMeta('tilt')
const columns = ["记录编号", "测点编号", "观测方向", "倾斜角度", "变化量", "累积倾斜量", "观测人", "记录状态"]
const actions = ["提交校核", "确认校核", "触发报警"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const summary = ref<ModuleStat>({ created: 0, pending: 0, abnormal: 0, byStatus: [] })
const stats = computed(() => [
  { label: '登记总量', value: summary.value.created },
  { label: '未结事项', value: summary.value.pending },
  { label: '异常量', value: summary.value.abnormal },
])
const statusSummary = computed(() => summary.value.byStatus)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '倾斜记录登记入口尚未接入审批流'
}

async function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = await applyAction(meta.key, Number(row.id), action, String(row.status))
  reload()
  if (!result.ok) {
    errorMessage.value = result.message
  }
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = loadModulePage(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    summary.value = payload.summary
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '倾斜监测列表读取失败'
  }
}

onMounted(reload)
</script>
