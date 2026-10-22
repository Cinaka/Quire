const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { stripTypeScriptTypes } = require('node:module')
const { createNotebookIdentityGate } = require('../src/capabilities/notebookIdentityGate.ts')
const { notebookTargetIndex } = require('../src/shared/notebookNavigation.ts')
const tick = () => new Promise(setImmediate)
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function identity() {
  let now = 1000, expiresAt = 2000, calls = 0, closes = 0
  let verify = async () => ({ id: 'A' })
  const gate = createNotebookIdentityGate({
    auth: () => ({ subject: 'A', generation: 1, expiresAt }),
    owner: async () => ({ ownerUserId: 'A', generation: 'e1' }),
    now: () => now,
    verify: () => { calls++; return verify() },
    open: () => ({ close() { closes++ }, assertCurrent: async () => {},
      readEntry: async () => undefined, readMedia: async () => ({ state: 'missing' }),
      subscribe: () => () => {}, subscribeMedia: () => () => {} }),
  })
  return { gate, get calls() { return calls }, get closes() { return closes },
    expire() { now = 3000 }, refresh() { expiresAt = 5000 }, verify(fn) { verify = fn } }
}
for (const response of ['401', 'wrong subject']) {
  test(`failed renewed identity (${response}) cannot revive an expired memory proof`, async () => {
    const f = identity()
    ;(await f.gate.open(() => {})).close()
    f.expire()
    f.verify(async () => {
      f.refresh()
      if (response === '401') throw Error('401 after refresh')
      return { id: 'B' }
    })
    await assert.rejects(f.gate.open(() => {}))
    f.verify(async () => { throw Error('offline requires new proof') })
    await assert.rejects(f.gate.open(() => {}), /offline requires new proof/)
    assert.equal(f.calls, 3)
  })
}
test('required revalidation closes old readers before its result, without reviving them on failure', async () => {
  const f = identity(), pending = deferred()
  let failed = 0
  await f.gate.open(() => failed++)
  f.expire(); f.verify(() => pending.promise)
  const attempt = f.gate.open(() => {})
  await tick()
  assert.equal(f.closes, 1); assert.equal(failed, 1)
  pending.reject(Error('401')); await assert.rejects(attempt, /401/)
})
test('late failed verification does not revoke a newer verified session', async () => {
  const f = identity(), old = deferred()
  f.verify(() => old.promise)
  const attempt = f.gate.open(() => {})
  await tick(); f.gate.invalidate()
  f.verify(async () => ({ id: 'A' }))
  const current = await f.gate.open(() => { throw Error('new session revoked') })
  old.reject(Error('old failure')); await assert.rejects(attempt, /old failure/)
  f.verify(async () => { throw Error('offline') })
  ;(await f.gate.open(() => {})).close(); current.close()
  assert.equal(f.calls, 2)
})

// Execute the production handler, not a reimplementation. Refs/ports are injected:
// this is deterministic handler testing, not Vue mounting or browser/IndexedDB E2E.
function movingReader() {
  const source = fs.readFileSync(path.join(__dirname, '../src/views/ListView.vue'), 'utf8')
  const start = source.indexOf('async function move(')
  const end = source.indexOf('\nfunction refreshUnavailable', start)
  assert.ok(start >= 0 && end > start)
  const entered = deferred(), guard = deferred()
  let calls = 0
  const port = { assertCurrent: async () => {
    if (++calls === 2) { entered.resolve(); await guard.promise }
  } }
  const state = {
    moving: { value: false }, loading: { value: false }, readPort: { value: port },
    revision: { value: 0 }, anchor: { value: 'old0' },
    entryIds: { value: ['old0', 'old1', 'old2', 'old3'] }, width: { value: 375 },
    hasMore: { value: false }, queryError: { value: '' }, protectedTarget: { value: false },
    disposed: false, notebookTargetIndex, loadMore: async () => {},
    fallback() { throw Error('unexpected identity fallback') },
  }
  vm.createContext(state)
  vm.runInContext(stripTypeScriptTypes(source.slice(start, end)) + '\nglobalThis.runMove = move', state)
  return { state, entered, guard }
}
const changes = {
  'filter revision': s => { s.revision.value++; s.entryIds.value = ['new0', 'new1']; s.anchor.value = 'new0' },
  'unmount': s => { s.disposed = true },
  'port replacement': s => { s.readPort.value = {} },
  'resize': s => { s.width.value = 1440 },
  'anchor change': s => { s.anchor.value = 'old2' },
  'query error': s => { s.queryError.value = 'query failed' },
  'result replacement': s => { s.entryIds.value = ['old0', 'replacement', 'old2'] },
}
for (const [name, change] of Object.entries(changes)) {
  test(`late final flip guard cannot publish after ${name}`, async () => {
    const f = movingReader(), work = f.state.runMove(1)
    await f.entered.promise; change(f.state)
    const expected = f.state.anchor.value
    f.guard.resolve(); await work
    assert.equal(f.state.anchor.value, expected)
    assert.equal(f.state.moving.value, false)
  })
}
test('unchanged final flip guard publishes the intended entry', async () => {
  const f = movingReader(), work = f.state.runMove(1)
  await f.entered.promise; f.guard.resolve(); await work
  assert.equal(f.state.anchor.value, 'old1')
  assert.equal(f.state.moving.value, false)
})
test('late successful verification cannot replace a newer memory proof', async () => {
  const f = identity(), old = deferred()
  f.verify(() => old.promise)
  const attempt = f.gate.open(() => {})
  await tick(); f.gate.invalidate()
  f.verify(async () => ({ id: 'A' }))
  const current = await f.gate.open(() => { throw Error('new session revoked') })
  old.resolve({ id: 'A' }); await assert.rejects(attempt, /上下文已变化/)
  f.verify(async () => { throw Error('offline') })
  ;(await f.gate.open(() => {})).close(); current.close()
  assert.equal(f.calls, 2)
})
test('invalidation while the final owner read is pending cannot publish a port', async () => {
  const pending = deferred(), entered = deferred()
  let reads = 0, opens = 0
  const gate = createNotebookIdentityGate({
    auth: () => ({ subject: 'A', generation: 1, expiresAt: 2000 }), now: () => 1000,
    owner: async () => {
      if (++reads === 2) { entered.resolve(); await pending.promise }
      return { ownerUserId: 'A', generation: 'e1' }
    },
    verify: async () => ({ id: 'A' }), open: () => { opens++; throw Error('must not open') },
  })
  const work = gate.open(() => {})
  await entered.promise; gate.invalidate(); pending.resolve()
  await assert.rejects(work, /上下文已变化/)
  assert.equal(opens, 0)
})
