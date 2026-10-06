// 结算口径与并发控制的逻辑验证：不依赖浏览器，用最小 localStorage 桩加载真实数据层。
// 运行：node --loader tsx 不可用时用 esbuild 即时转译；仓库已带 esbuild，故走 esbuild register。
const assert = require('node:assert')

// --- 最小浏览器桩 ---
const mem = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  },
  addEventListener: () => {},
}

async function main() {
  // 用 esbuild 的同步转译加载 TS：CJS 的 require 必须同步返回，不能用异步构建。
  const { transformSync } = require('esbuild')
  const fs = await import('node:fs')
  const path = await import('node:path')
  const vm = await import('node:vm')

  const srcRoot = path.resolve('src')
  const cache = new Map()

  function loadTs(spec) {
    // 统一以绝对路径作为缓存键，避免 @/ 与相对路径加载出两份模块实例。
    let file = spec
    if (spec.startsWith('@/')) file = path.join(srcRoot, spec.slice(2))
    else if (spec.startsWith('.')) file = path.resolve(spec)
    if (!file.endsWith('.ts')) file += '.ts'
    if (cache.has(file)) return cache.get(file)
    const code = fs.readFileSync(file, 'utf8')
    const out = transformSync(code, { loader: 'ts', format: 'cjs' })
    const module = { exports: {} }
    const localRequire = (dep) => {
      if (dep.startsWith('@/')) {
        const resolved = path.join(srcRoot, dep.slice(2))
        return loadTs(resolved.endsWith('.ts') ? resolved : resolved + '.ts')
      }
      if (dep.startsWith('./') || dep.startsWith('../')) {
        return loadTs(path.resolve(path.dirname(file), dep))
      }
      return require(dep)
    }
    const fn = vm.runInThisContext(
      `(function(exports,require,module){${out.code}\n})`,
      { filename: file },
    )
    fn(module.exports, localRequire, module)
    // esbuild 会重赋 module.exports，必须在执行完毕后缓存最终对象。
    cache.set(file, module.exports)
    return module.exports
  }

  const store = await loadTs('@/data/local-store')
  const svc = await loadTs('@/api/local-service')

  // 1. 播种后总览与明细同口径：隐患点种子 3 行（在册/监测中=未结 2，已治理=终态 0 异常）
  let overview = svc.loadOverview()
  const hazardRow = overview.modules.find((m) => m.name === '隐患点台账')
  assert.strictEqual(hazardRow.created, 3)
  assert.strictEqual(hazardRow.pending, 2, '在册/监测中未结应为 2')
  assert.strictEqual(hazardRow.abnormal, 0, '播种按口径重算后隐患点无异常')

  // 2. 完成（申请核销=作废类终态）后汇总立即更新，旧值不残留
  let r = svc.runAction('hazard', 1, '申请核销')
  assert.strictEqual(r.ok, true, r.message)
  overview = svc.loadOverview()
  assert.strictEqual(overview.modules.find((m) => m.name === '隐患点台账').pending, 1, '核销后未结剩 1')
  assert.strictEqual(overview.modules.find((m) => m.name === '隐患点台账').abnormal, 0, '已核销是作废但非异常')

  // 3. 重复同一动作被拒绝，不产生第二次结算
  r = svc.runAction('hazard', 1, '申请核销')
  assert.strictEqual(r.ok, false)
  const vAfterDup = store.currentVersion()
  r = svc.runAction('hazard', 2, '纳入监测')
  assert.strictEqual(r.ok, false) // 已是监测中
  assert.strictEqual(store.currentVersion(), vAfterDup, '幂等拒绝不增加版本/汇总')

  // 4. 异常按状态判定：形变 id=1 标记异常 -> abnormal+1；再确认校核办结 -> 异常清零、未结只剩待校核
  const defo = () => svc.loadOverview().modules.find((m) => m.name === '形变观测')
  assert.strictEqual(defo().abnormal, 0, '播种重算后：待校核不属于异常态')
  assert.strictEqual(defo().pending, 2)
  r = svc.runAction('deformation', 1, '标记异常')
  assert.strictEqual(r.ok, true)
  assert.strictEqual(defo().abnormal, 1)
  r = svc.runAction('deformation', 1, '确认校核')
  assert.strictEqual(r.ok, true)
  assert.strictEqual(defo().abnormal, 0, '办结后旧异常标记必须清掉')
  assert.strictEqual(defo().pending, 1, '仅剩 id2 待校核未结')

  // 5. 总览与待办同一批数据：待办总数 == 总览待处理
  const dash = svc.loadDashboard()
  const totalPending = dash.overview.cards.find((c) => c.label === '待处理').value
  assert.strictEqual(dash.todos.length, totalPending, '待办清单与总览未结数一致')
  assert.ok(dash.todos.some((t) => t.moduleKey === 'hazard' && t.id === 2))
  const dashAgain = svc.loadDashboard()
  assert.strictEqual(dashAgain.todos.length, totalPending, '重复刷新不累加')

  // 6. 导出实时且带结算标记
  const csv = svc.exportEntries('hazard').content
  const lines = csv.split('\n')
  assert.ok(lines[0].includes('是否未结') && lines[0].includes('结算口径'))
  const settled1 = lines.find((l) => l.startsWith('1,'))
  assert.ok(settled1.includes('已结') && settled1.includes('正常'), '已核销行导出为已结/正常')
  assert.ok(settled1.includes('2026-10-01'))

  // 7. 并发结算：同一期望版本只有一个请求成功，另一个要求刷新
  const v = store.currentVersion()
  // 模拟另一终端先提交成功（版本推进）
  const first = store.commitModule(v, 'hazard', (rows) => {
    rows[1] = { ...rows[1], status: '已治理' }
    return rows
  })
  assert.strictEqual(first.ok, true)
  const second = store.commitModule(v, 'hazard', (rows) => {
    rows[0] = { ...rows[0], status: '监测中' }
    return rows
  })
  assert.strictEqual(second.ok, false, '旧版本的并发结算必须失败')
  assert.match(second.error.message, /刷新/)

  // 8. 写一半必须回滚：mutate 抛错时版本与数据不变
  const vBefore = store.currentVersion()
  const pendingBefore = svc.loadOverview().cards.find((c) => c.label === '待处理').value
  const bad = store.commitSettlement(vBefore, () => {
    throw new Error('boom')
  })
  assert.strictEqual(bad.ok, false)
  assert.strictEqual(store.currentVersion(), vBefore, '失败不推进版本')
  assert.strictEqual(
    svc.loadOverview().cards.find((c) => c.label === '待处理').value,
    pendingBefore,
    '失败后汇总回滚',
  )

  // 8b. 跨终端互斥：同一时刻两个终端同时结算，只有一个能拿到锁
  const lockA = (() => {
    // 直接走一次结算持有锁不现实（锁在 finally 释放），这里手工植入有效锁来验证排他。
    globalThis.window.localStorage.setItem(
      'geohazard-monitor-prevention:settle-lock',
      JSON.stringify({ owner: 'other-terminal', at: Date.now() }),
    )
    return store.commitModule(store.currentVersion(), 'hazard', (rows) => rows)
  })()
  assert.strictEqual(lockA.ok, false, '别的终端持锁期间，本终端结算必须被拒绝')
  assert.match(lockA.error.message, /终端|冲突/)
  globalThis.window.localStorage.removeItem('geohazard-monitor-prevention:settle-lock')

  // 锁过期（持有者崩溃）后其他终端可接管
  globalThis.window.localStorage.setItem(
    'geohazard-monitor-prevention:settle-lock',
    JSON.stringify({ owner: 'dead-terminal', at: Date.now() - 20_000 }),
  )
  const takeover = store.commitModule(store.currentVersion(), 'hazard', (rows) => rows)
  assert.strictEqual(takeover.ok, true, '锁超时后允许接管')

  // 9. 落库失败（setItem 抛错）整单回滚，缓存不切换
  const realSet = globalThis.window.localStorage.setItem
  globalThis.window.localStorage.setItem = (k, val) => {
    if (k === 'geohazard-monitor-prevention:entries') throw new Error('quota')
    realSet(k, val)
  }
  const vFail = store.currentVersion()
  const writeFail = store.commitModule(vFail, 'hazard', (rows) => {
    rows[0] = { ...rows[0], status: '监测中' }
    return rows
  })
  assert.strictEqual(writeFail.ok, false)
  assert.strictEqual(store.currentVersion(), vFail, '落库失败回滚，版本不变')
  globalThis.window.localStorage.setItem = realSet

  // 10. 历史班次不重算：塞入无结算戳记的旧版数据，读取时保留旧标记
  mem.clear()
  mem.set(
    'geohazard-monitor-prevention:entries',
    JSON.stringify({
      hazard: [
        { id: 99, status: '已核销', pending: true, abnormal: true }, // 旧口径下的历史行
      ],
    }),
  )
  // 重新加载模块以清模块内缓存
  cache.clear()
  const store2 = await loadTs('@/data/local-store')
  const svc2 = await loadTs('@/api/local-service')
  const legacyDash = svc2.loadDashboard()
  const legacyHazard = legacyDash.overview.modules.find((m) => m.name === '隐患点台账')
  assert.strictEqual(legacyHazard.pending, 1, '历史行保留当时口径：仍计未结')
  assert.strictEqual(legacyHazard.abnormal, 1, '历史行保留当时口径：仍计异常')
  assert.strictEqual(legacyDash.legacy, true)
  // 对历史行执行新动作 -> 仅该行按新口径结算，其他历史行不动
  const act = svc2.runAction('hazard', 99, '申请核销')
  assert.strictEqual(act.ok, false) // 已是已核销，幂等拒绝
  const act2 = svc2.runAction('hazard', 99, '纳入监测')
  assert.strictEqual(act2.ok, true)
  const after = svc2.loadDashboard().overview.modules.find((m) => m.name === '隐患点台账')
  assert.strictEqual(after.pending, 1, '监测中按新口径仍未结')
  assert.strictEqual(after.abnormal, 0, '重新结算后异常按新口径清除')

  console.log('全部断言通过 ✅')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
