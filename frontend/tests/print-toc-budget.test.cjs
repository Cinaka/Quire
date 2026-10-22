const { test } = require('node:test'), assert = require('node:assert/strict')
const path = require('node:path'), fs = require('node:fs')
const guards = import('../tools/print-lab/print-guards.mjs')
const { allowed, start } = require('../tools/print-lab/serve.cjs')
const stats = () => ({ entries: 0, textBytes: 0, mediaBytes: 0, logicalPages: 0, nodes: 0 })
for (const key of ['entries', 'textBytes', 'mediaBytes', 'logicalPages', 'nodes']) {
  test(`${key}: exact boundary accepted, plus one rejected`, async () => {
    const { LIMITS, assertBudget } = await guards
    assert.doesNotThrow(() => assertBudget({ ...stats(), [key]: LIMITS[key] }))
    assert.throws(() => assertBudget({ ...stats(), [key]: LIMITS[key] + 1 }), { code: `LIMIT_${key}` })
  })
  test(`${key}: malformed counts cannot bypass budget`, async () => {
    const { assertBudget } = await guards
    for (const value of [NaN, Infinity, -1, .5, '1', undefined, null]) assert.throws(() => assertBudget({ ...stats(), [key]: value }), { code: `INVALID_${key}` })
  })
}
test('nine relative headings retain exact final page references after convergence', async () => {
  const { settleToc } = await guards
  const result = await settleToc([1, 2, 3, 4, 5, 6, 7, 8, 9], async labels => {
    assert(Object.isFrozen(labels)); return { pageCount: 3 }
  })
  assert.equal(result.tocPages, 3); assert.deepEqual(result.labels, [5, 6, 7, 8, 9, 10, 11, 12, 13]); assert.equal(result.trace.length, 2)
})
test('injected 2/3-digit transitions converge without claiming actual hundred-page DOM', async () => {
  const { settleToc } = await guards
  const result = await settleToc([7, 8, 97, 98, 297], async () => ({ pageCount: 2 }))
  assert.deepEqual(result.labels, [10, 11, 100, 101, 300])
})
test('oscillation is rejected rather than emitting wrong TOC', async () => {
  const { settleToc } = await guards; let calls = 0
  await assert.rejects(settleToc([1], async () => ({ pageCount: ++calls % 2 ? 2 : 1 })), { code: 'TOC_CYCLE' }); assert.equal(calls, 2)
})
test('non-repeating divergence stops at eight attempts', async () => {
  const { settleToc } = await guards; let calls = 0
  await assert.rejects(settleToc([1], async () => ({ pageCount: ++calls + 1 })), { code: 'TOC_ITERATION_LIMIT' }); assert.equal(calls, 8)
})
test('cancel before callback does not begin layout', async () => {
  const { settleToc } = await guards, c = new AbortController(); c.abort()
  await assert.rejects(settleToc([1], () => { assert.fail('late layout') }, { signal: c.signal }), { code: 'CANCELLED' })
})
test('cancel during final await blocks ready result', async () => {
  const { settleToc } = await guards, c = new AbortController()
  await assert.rejects(settleToc([1], async () => { c.abort(); return { pageCount: 1 } }, { signal: c.signal }), { code: 'CANCELLED' })
})
test('logical fake clock past time limit rejects even a stable late result', async () => {
  const { settleToc } = await guards; let clock = 0
  await assert.rejects(settleToc([1], async () => { clock = 20001; return { pageCount: 1 } }, { now: () => clock }), { code: 'TIME_LIMIT' })
})
test('invalid or oversized heading ranges reject before callback', async () => {
  const { settleToc } = await guards
  for (const starts of [[], [0], [1, .5], [2, 1], [NaN], [301], Array(101).fill(1)]) await assert.rejects(settleToc(starts, () => assert.fail('not called')), { code: 'INVALID_BODY_STARTS' })
})
test('invalid TOC page counts are explicit failures', async () => {
  const { settleToc } = await guards
  for (const value of [0, -1, NaN, 1.2, '1']) await assert.rejects(settleToc([1], async () => ({ pageCount: value })), { code: 'INVALID_TOC_COUNT' })
})
test('cover plus TOC participates in the total logical page limit', async () => {
  const { settleToc } = await guards
  assert.equal((await settleToc([298], async () => ({ pageCount: 1 }))).labels[0], 300)
  await assert.rejects(settleToc([298], async () => ({ pageCount: 2 })), { code: 'LIMIT_logicalPages' })
})
test('relative heading input is cloned across asynchronous callbacks', async () => {
  const { settleToc } = await guards, starts = [1]
  const result = await settleToc(starts, async () => { starts[0] = 200; return { pageCount: 2 } })
  assert.deepEqual(result.labels, [4])
})
test('new isolated page keeps source-safe insertion and no app/private APIs', () => {
  const s = fs.readFileSync(path.join(__dirname, '../tools/print-lab/toc-budget.mjs'), 'utf8')
  assert(!/innerHTML|\b(?:fetch|XMLHttpRequest|indexedDB|localStorage|sessionStorage)\s*[.(]/.test(s))
  assert(s.includes("location.port !== '5184'")); assert(s.includes('TOC_REFERENCE_MISMATCH')); assert(s.includes('output.replaceChildren()'))
  for (const file of ['toc-budget.html', 'toc-budget.css', 'toc-budget.mjs', 'print-guards.mjs']) assert(allowed('/frontend/tools/print-lab/' + file))
  assert(!allowed('/frontend/tools/print-lab/secret.mjs')); assert(!allowed('/frontend/src/db/schema.ts'))
})
test('actual HTTP server denies APIs, POST and wrong host; serves new fixed page', async () => {
  const server = start(); if (!server.listening) await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  try {
    const base = 'http://127.0.0.1:5184'
    const page = await fetch(base + '/frontend/tools/print-lab/toc-budget.html'); assert.equal(page.status, 200); assert((await page.text()).includes('connect-src'))
    assert.equal((await fetch(base + '/api/v1/auth/me')).status, 404)
    assert.equal((await fetch(base + '/frontend/tools/print-lab/print-guards.mjs', { method: 'POST' })).status, 403)
    const wrongHost = await new Promise((resolve, reject) => { const req = require('node:http').get(base + '/frontend/tools/print-lab/toc-budget.html', { headers: { Host: 'localhost:5184' } }, res => { res.resume(); resolve(res.statusCode) }); req.on('error', reject) }); assert.equal(wrongHost, 403)
  } finally { await new Promise(resolve => server.close(resolve)) }
})
