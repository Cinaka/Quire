const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadTS } = require('./schedules-harness.cjs')
const { content } = require('./schedules-data-harness.cjs')
const clone = value => JSON.parse(JSON.stringify(value))
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }
const body = { remindDate: '2026-10-09', title: '保留输入', content: content('尚未确认落库的文字') }
function setup(overrides = {}) {
  let closed = false
  const calls = { persist: 0, submit: 0, clear: 0, close: 0, flush: 0 }
  const session = {
    inspect: () => ({ payload: clone(body), status: 'empty', closed }),
    async persist() { calls.persist++; return { status: 'ready' } },
    async submit() { calls.submit++ },
    async discard() { calls.clear++; closed = true },
    async flush() { calls.flush++ },
    close() { calls.close++; closed = true }, ...overrides,
  }
  const panel = loadTS('shared/scheduleEditorPanel.ts').createScheduleEditorPanel(session)
  return { panel, session, calls }
}
for (const reason of ['切换账号', '同账号恢复', '退出再登录', '监听读取失败']) {
  test(`${reason}: freeze preserves last visible body, blocks all persisted actions and requires explicit memory discard`, async () => {
    const h = setup(); await h.panel.change({ ...body, title: reason })
    const before = h.panel.inspect().body
    h.panel.freeze(); h.panel.freeze()
    assert.equal(h.calls.close, 1)
    assert.deepEqual(h.panel.inspect().body, before)
    assert.equal(h.panel.inspect().expired, true); assert.equal(h.panel.inspect().closed, false)
    assert.equal(h.panel.needsLeaveConfirmation(), true)
    assert.equal(await h.panel.change({ ...body, title: '不能重放' }), false)
    assert.equal(await h.panel.submit(), false); assert.equal(await h.panel.discardConfirmed(), false)
    assert.equal(await h.panel.prepareLeave(), false)
    assert.deepEqual(h.calls, { persist: 1, submit: 0, clear: 0, close: 1, flush: 0 })
    // 取消复制/弃去对话框不会调用此方法，内存文字仍可读取。
    assert.deepEqual(h.panel.inspect().body, before)
    assert.equal(h.panel.discardMemoryConfirmed(), true)
    assert.equal(h.panel.inspect().closed, true); assert.equal(h.calls.clear, 0)
    assert.equal(h.panel.needsLeaveConfirmation(), false)
    assert.equal(h.panel.discardMemoryConfirmed(), false)
  })
}
for (const failure of [false, true]) {
  for (const method of ['persist', 'submit', 'flush', 'discard']) {
    test(`late ${method} ${failure ? 'failure' : 'success'} cannot close/unfreeze editor or replace frozen notice`, async () => {
      const waiting = gate(); const entered = gate()
      const h = setup({ async [method]() { entered.release(); await waiting.promise; if (failure) throw new Error('晚到响应'); return { status: 'empty' } } })
      const action = { persist: () => h.panel.change({ ...body, title: '最新输入' }), submit: () => h.panel.submit(), flush: () => h.panel.prepareLeave(), discard: () => h.panel.discardConfirmed() }[method]
      const work = action(); await entered.promise; h.panel.freeze()
      const snapshot = h.panel.inspect().body
      assert.equal(h.panel.discardMemoryConfirmed(), false)
      waiting.release(); assert.equal(await work, false)
      assert.equal(h.panel.inspect().expired, true); assert.equal(h.panel.inspect().closed, false)
      assert.deepEqual(h.panel.inspect().body, snapshot)
      assert.equal(h.panel.inspect().pending, 0); assert.equal(h.panel.inspect().busy, false)
      assert.equal(h.panel.needsLeaveConfirmation(), true)
      assert.equal(h.panel.discardMemoryConfirmed(), true); assert.equal(h.calls.clear, 0)
    })
  }
}
test('normal editor does not offer memory-only discard and successful flush still closes normally', async () => {
  const h = setup(); assert.equal(h.panel.discardMemoryConfirmed(), false)
  assert.equal(h.panel.needsLeaveConfirmation(), false)
  await h.panel.change(body); assert.equal(h.panel.needsLeaveConfirmation(), false)
  assert.equal(await h.panel.prepareLeave(), true); assert.equal(h.panel.inspect().closed, true)
  assert.equal(h.calls.flush, 1); assert.equal(h.calls.clear, 0)
})
test('pending/failed unsaved text participates in unload protection without pretending all edits are lost', async () => {
  const waiting = gate(); const h = setup({ async persist() { await waiting.promise; throw new Error('quota') } })
  const work = h.panel.change(body); assert.equal(h.panel.needsLeaveConfirmation(), true)
  waiting.release(); assert.equal(await work, false); assert.equal(h.panel.needsLeaveConfirmation(), true)
  assert.equal(await h.panel.prepareLeave(), false); assert.equal(h.panel.inspect().closed, false)
})
test('frozen state returns independent copy and disposal stops future notifications', () => {
  const h = setup(); let signals = 0; h.panel.subscribe(() => signals++)
  h.panel.freeze(); const observed = h.panel.inspect(); observed.body.title = '不能改变原输入'
  assert.equal(h.panel.inspect().body.title, body.title)
  h.panel.dispose(); const before = signals; h.panel.freeze()
  assert.equal(signals, before); assert.equal(h.panel.discardMemoryConfirmed(), false)
})
const source = name => fs.readFileSync(path.join(__dirname, '../src', name), 'utf8')
test('host retains pinned workspace through expiry and forwards freeze without automatic remount', () => {
  const host = source('components/schedules/ScheduleHost.vue')
  assert.match(host, /<template v-if="workspacePort">/)
  assert.match(host, /if \(nextWorkspace\) workspacePort.value = nextWorkspace/)
  assert.match(host, /:expired="state.expired"/)
  assert.match(host, /workspaceRef.value\?\.needsLeaveConfirmation\(\)/)
  assert.doesNotMatch(host, /workspacePort.value = host.workspacePort\(\)|:key=".*expired|:key=".*context/)
})
test('workspace forwards freeze, never clears storage on invalidation and leaves only after explicit editor closure', () => {
  const workspace = source('components/schedules/ScheduleWorkspace.vue')
  assert.match(workspace, /:expired="state.expired"/)
  assert.match(workspace, /watch\(\(\) => props.expired/)
  assert.match(workspace, /editorRef.value\?\.needsLeaveConfirmation\(\)/)
  const core = source('shared/scheduleWorkspace.ts')
  const invalidation = core.slice(core.indexOf('function invalidate('), core.indexOf('  return {', core.indexOf('function invalidate(')))
  assert.match(invalidation, /session\?\.close\(\)/)
  assert.doesNotMatch(invalidation, /session = null|port\.|\.clear\(|\.delete\(/)
})
test('frozen UI provides selectable local copy and explicit confirmation; it cannot use old storage discard', () => {
  const component = source('components/schedules/ScheduleEditorPanel.vue')
  assert.match(component, /textarea readonly :value="memoryCopy"/)
  assert.match(component, /JSON.stringify\(body.value, null, 2\)/)
  assert.match(component, /state.value.expired/)
  assert.match(component, /window.confirm\("明确弃去此失效面板/)
  assert.match(component, /panel.discardMemoryConfirmed\(\)/)
  assert.match(component, /flush: "sync"/)
  assert.doesNotMatch(component, /localStorage|clipboard|fetch\(|@\/db\//)
})
