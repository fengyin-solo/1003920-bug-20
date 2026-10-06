<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常。总览、明细与待办共用同一结算口径。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新统计</button>
      </div>
    </header>
    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>今日新增</th><th>待处理</th><th>异常量</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td>{{ row.abnormal }}</td>
        </tr>
      </tbody>
    </table>

    <section class="todo-panel">
      <header class="todo-head">
        <h3>关联业务面待办清单</h3>
        <span class="todo-count">共 {{ todos.length }} 项未结，与上方总览取自同一批数据</span>
      </header>
      <table class="data-table">
        <thead>
          <tr><th>所属模块</th><th>业务编号</th><th>当前状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in todos" :key="`${item.moduleKey}-${item.id}`">
            <td>{{ item.moduleName }}</td>
            <td>{{ item.title }}</td>
            <td>{{ item.status }}</td>
            <td class="row-actions">
              <RouterLink class="link" :to="`/${item.moduleKey}`">前往处理</RouterLink>
            </td>
          </tr>
          <tr v-if="!todos.length">
            <td colspan="4" class="empty-state">没有未结事项</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>当前结算口径：{{ ruleVersion }}；「重新统计」只重新读数，不会重复累加汇总</span>
      <span v-if="legacy" class="error-text">存在历史班次数据，按其当时口径展示，未按新口径重算</span>
      <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

import { loadDashboard } from '@/api/local-service'
import { storageKey } from '@/data/local-store'
import type { OverviewResult, TodoItem } from '@/data/types'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])
const todos = ref<TodoItem[]>([])
const ruleVersion = ref('')
const legacy = ref(false)

// 一次读取同时拿到总览与待办：两者来自同一批已结算数据，重复刷新只是重读同一批数据。
function refresh() {
  const payload = loadDashboard()
  cards.value = payload.overview.cards
  moduleRows.value = payload.overview.modules
  todos.value = payload.todos
  ruleVersion.value = payload.ruleVersion
  legacy.value = payload.legacy
}

// 其他终端结算后自动重读，总览与待办始终对齐最新落库批次。
function onStorage(event: StorageEvent) {
  if (event.key === storageKey() || event.key === null) {
    refresh()
  }
}

onMounted(() => {
  refresh()
  window.addEventListener('storage', onStorage)
})

onUnmounted(() => window.removeEventListener('storage', onStorage))
</script>
