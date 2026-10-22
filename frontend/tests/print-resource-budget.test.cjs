const { test } = require('node:test'), assert = require('node:assert/strict')
const modulePromise = import('../tools/print-lab/resource-budget.mjs')
const fixtures = import('../tools/print-lab/resource-fixtures.mjs')
const doc = n => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(n) }] }] })
const smallPlan = async () => { const { preflightImages } = await modulePromise, { fixtureBlob } = await fixtures; return preflightImages([{ id: 'public', blob: fixtureBlob('png') }]) }
const bitmap = (width = 512, height = 768) => ({ width, height, closed: 0, close() { this.closed++ } })
const rejection = (promise, code) => assert.rejects(promise, { code })
test('real fixed PNG/JPEG/WebP headers parsed at expected dimensions', async () => {
  const { preflightImages } = await modulePromise, { fixtureBlob } = await fixtures
  const p = await preflightImages(['png', 'jpeg', 'webp'].map(id => ({ id, blob: fixtureBlob(id) })))
  assert.deepEqual(p.items.map(i => [i.width, i.height]), [[512, 768], [512, 384], [384, 256]])
})
test('8MP exact and 24MP total accepted; another image rejected before decode', async () => {
  const { preflightImages } = await modulePromise, { fixtureBlob } = await fixtures, blob = fixtureBlob('large')
  const records = Array.from({ length: 3 }, (_, i) => ({ id: String(i), blob }))
  const p = await preflightImages(records); assert.equal(p.pixels, 24000000)
  await rejection(preflightImages([...records, { id: '4', blob }]), 'TOTAL_PIXEL_LIMIT')
})
test('single pixel and long-edge bounds reject huge declared sizes', async () => {
  const { assertPixels, preflightImages } = await modulePromise, { fixtureBlob } = await fixtures
  assert.equal(assertPixels(4000, 2000), 8000000)
  assert.throws(() => assertPixels(4001, 2000), { code: 'IMAGE_PIXEL_LIMIT' })
  assert.throws(() => assertPixels(1, 8193), { code: 'IMAGE_DIMENSION_LIMIT' })
  for (const value of [0, -1, .5, NaN, Infinity]) assert.throws(() => assertPixels(value, 1), { code: 'INVALID_DIMENSIONS' })
  const bytes = new Uint8Array(await fixtureBlob('png').arrayBuffer()); new DataView(bytes.buffer).setUint32(16, 100000)
  await rejection(preflightImages([{ id: 'bomb', blob: new Blob([bytes], { type: 'image/png' }) }]), 'IMAGE_DIMENSION_LIMIT')
})
test('same media ID is counted once; inconsistent duplicate rejected', async () => {
  const { preflightImages } = await modulePromise, { fixtureBlob } = await fixtures, blob = fixtureBlob('png')
  const p = await preflightImages([{ id: 'a', blob }, { id: 'a', blob }]); assert.equal(p.items.length, 1); assert.equal(p.bytes, blob.size)
  await rejection(preflightImages([{ id: 'a', blob }, { id: 'a', blob: fixtureBlob('png') }]), 'AMBIGUOUS_IMAGE_REFERENCE')
})
test('file bytes and count caps refuse before parsing image bytes', async () => {
  const { preflightImages } = await modulePromise
  const blob = new Blob([new Uint8Array(12 * 1024 ** 2 + 1)], { type: 'image/png' })
  await rejection(preflightImages([{ id: 'big', blob }]), 'IMAGE_BYTE_LIMIT')
  const byte = new Blob(['x'], { type: 'image/png' })
  await rejection(preflightImages(Array.from({ length: 101 }, (_, i) => ({ id: String(i), blob: byte }))), 'IMAGE_COUNT_LIMIT')
})
test('aggregate 64MiB byte cap refuses before any header decode', async () => {
  const { preflightImages } = await modulePromise
  const blob = new Blob([new Uint8Array(12 * 1024 ** 2)], { type: 'image/png' })
  await rejection(preflightImages(Array.from({ length: 6 }, (_, i) => ({ id: String(i), blob }))), 'MEDIA_BYTE_LIMIT')
})
test('unsupported types, mismatched signatures and truncated data are explicit blockers', async () => {
  const { preflightImages } = await modulePromise, { fixtureBlob } = await fixtures
  await rejection(preflightImages([{ id: 'gif', blob: new Blob(['GIF89a'], { type: 'image/gif' }) }]), 'UNSUPPORTED_IMAGE_TYPE')
  await rejection(preflightImages([{ id: 'svg', blob: new Blob(['<svg/>'], { type: 'image/svg+xml' }) }]), 'UNSUPPORTED_IMAGE_TYPE')
  await rejection(preflightImages([{ id: 'lie', blob: new Blob([await fixtureBlob('png').arrayBuffer()], { type: 'image/jpeg' }) }]), 'INVALID_IMAGE_HEADER')
  await rejection(preflightImages([{ id: 'cut', blob: fixtureBlob('png').slice(0, 30, 'image/png') }]), 'INVALID_IMAGE_HEADER')
})
test('decode queue is actually serial, closes every bitmap, releases slot', async () => {
  const { SerialImageDecoder, preflightImages } = await modulePromise, { fixtureBlob } = await fixtures, blob = fixtureBlob('png')
  const p = await preflightImages([{ id: '1', blob }, { id: '2', blob }, { id: '3', blob }]), q = new SerialImageDecoder()
  let active = 0, peak = 0; const bitmaps = []
  const r = await q.run(p, { decode: async () => { peak = Math.max(peak, ++active); await new Promise(r => setTimeout(r, 2)); active--; const b = bitmap(); bitmaps.push(b); return b } })
  assert.equal(r.completed, 3); assert.equal(peak, 1); assert(bitmaps.every(b => b.closed === 1)); assert(!q.busy)
})
test('a plan cannot bypass preflight by forged width/size fields', async () => {
  const { SerialImageDecoder } = await modulePromise, q = new SerialImageDecoder()
  await rejection(q.run({ items: [] }, { decode: () => assert.fail('decode not permitted') }), 'UNVERIFIED_IMAGE_PLAN')
})
test('cancel before decoding performs no decoder work', async () => {
  const { SerialImageDecoder } = await modulePromise, q = new SerialImageDecoder(), c = new AbortController(); c.abort()
  await rejection(q.run(await smallPlan(), { signal: c.signal, decode: () => assert.fail('decode after abort') }), 'CANCELLED'); assert(!q.busy)
})
test('cancel while native decode is pending keeps slot until late bitmap is closed', async () => {
  const { SerialImageDecoder } = await modulePromise, q = new SerialImageDecoder(), c = new AbortController(), p = await smallPlan()
  let release; const b = bitmap(), pending = q.run(p, { signal: c.signal, decode: () => new Promise(r => { release = r }), onDecoded: () => assert.fail('stale preview') })
  await new Promise(r => setTimeout(r, 0)); c.abort(); await rejection(pending, 'CANCELLED'); assert(q.busy)
  await rejection(q.run(p), 'DECODER_BUSY'); release(b); await new Promise(r => setTimeout(r, 0)); assert.equal(b.closed, 1); assert(!q.busy)
})
test('deadline stops waiting, retains slot and disposes late bitmap', async () => {
  const { SerialImageDecoder } = await modulePromise, q = new SerialImageDecoder(), p = await smallPlan(); let release
  const b = bitmap(); await rejection(q.run(p, { timeoutMs: 10, decode: () => new Promise(r => { release = r }) }), 'DECODE_TIMEOUT')
  assert(q.busy); release(b); await new Promise(r => setTimeout(r, 0)); assert.equal(b.closed, 1); assert(!q.busy)
})
test('decoded mismatch is closed; subsequent task can run', async () => {
  const { SerialImageDecoder } = await modulePromise, q = new SerialImageDecoder(), p = await smallPlan(), b = bitmap(513, 768)
  await rejection(q.run(p, { decode: async () => b }), 'DECODE_DIMENSION_MISMATCH'); assert.equal(b.closed, 1)
  assert.equal((await q.run(p, { decode: async () => bitmap() })).completed, 1)
})
test('decode failure and consumer failure do not leak bitmaps', async () => {
  const { SerialImageDecoder } = await modulePromise, q = new SerialImageDecoder(), p = await smallPlan()
  await rejection(q.run(p, { decode: async () => { throw Error('bad compressed stream') } }), 'IMAGE_DECODE_FAILED')
  await new Promise(r => setTimeout(r, 0)); const b = bitmap()
  await rejection(q.run(p, { decode: async () => b, onDecoded: () => { throw Error('consumer error') } }), 'IMAGE_DECODE_FAILED'); assert.equal(b.closed, 1); assert(!q.busy)
})
test('JSON bytes match native UTF-8 including escapes, emoji, lone surrogate and shared trees', async () => {
  const { inspectDocuments } = await modulePromise, shared = { text: '甲🌿\\\n\t\u0001\ud800\udfff' }, documents = [{ a: shared, b: shared, x: [null, true, 1.25, -2e30] }]
  const r = await inspectDocuments(documents); assert.equal(r.bytes, new TextEncoder().encode(JSON.stringify(documents[0])).length)
})
test('real 4MiB JSON body accepted exactly; one byte over rejected', async () => {
  const { inspectDocuments } = await modulePromise, overhead = JSON.stringify(doc(0)).length
  const r = await inspectDocuments([doc(4 * 1024 ** 2 - overhead)]); assert.equal(r.bytes, 4 * 1024 ** 2)
  await rejection(inspectDocuments([doc(4 * 1024 ** 2 - overhead + 1)]), 'DOCUMENT_BYTE_LIMIT')
})
test('100 actual small entries accepted; 101 rejected', async () => {
  const { inspectDocuments } = await modulePromise
  assert.equal((await inspectDocuments(Array.from({ length: 100 }, () => doc(8)))).entries, 100)
  await rejection(inspectDocuments(Array(101).fill(null)), 'ENTRY_COUNT_LIMIT')
})
test('depth, JSON node budget and cycles stop without recursive overflow', async () => {
  const { inspectDocuments } = await modulePromise; let value = null
  for (let i = 0; i < 66; i++) value = [value]
  await rejection(inspectDocuments([value]), 'DOCUMENT_DEPTH_LIMIT')
  await rejection(inspectDocuments([Array(20000).fill(null)]), 'DOCUMENT_NODE_LIMIT')
  const cycle = {}; cycle.self = cycle; await rejection(inspectDocuments([cycle]), 'CYCLIC_DOCUMENT')
})
test('getters are not executed; unsupported non-JSON data is not silently lost', async () => {
  const { inspectDocuments } = await modulePromise, x = {}; let called = 0
  Object.defineProperty(x, 'text', { enumerable: true, get() { called++; return 'secret' } })
  await rejection(inspectDocuments([x]), 'UNSUPPORTED_JSON_VALUE'); assert.equal(called, 0)
  for (const value of [undefined, NaN, new Date(), () => {}, BigInt(1)]) await rejection(inspectDocuments([value]), 'UNSUPPORTED_JSON_VALUE')
})
test('cooperative yield can cancel actual large emoji input without publishing partial stats', async () => {
  const { inspectDocuments } = await modulePromise, c = new AbortController(); let ticks = 0, yielded = 0
  await rejection(inspectDocuments([doc(0).content, '🌿'.repeat(500000)], { signal: c.signal, now: () => ++ticks, yieldTask: async () => { yielded++; c.abort() } }), 'CANCELLED'); assert(yielded > 0)
})
test('cooperative deadline refuses an injected late stage', async () => {
  const { inspectDocuments } = await modulePromise; let time = 0
  await rejection(inspectDocuments(['x'], { now: () => { time += 10001; return time } }), 'DOCUMENT_TIME_LIMIT')
})
test('actual APNG and animated WebP fixtures block before native decode', async () => {
  const { preflightImages } = await modulePromise, { fixtureBlob } = await fixtures
  for (const id of ['apng', 'animatedWebp']) await rejection(preflightImages([{ id, blob: fixtureBlob(id) }]), 'ANIMATED_IMAGE_UNSUPPORTED')
})
test('truncated chunks and malicious declared chunk lengths do not escape bounds', async () => {
  const { preflightImages } = await modulePromise, { fixtureBlob } = await fixtures
  const bytes = new Uint8Array(await fixtureBlob('png').arrayBuffer()); new DataView(bytes.buffer).setUint32(33, 0xffffffff)
  await rejection(preflightImages([{ id: 'length', blob: new Blob([bytes], { type: 'image/png' }) }]), 'INVALID_IMAGE_HEADER')
})
test('preflight carries detached immutable records across awaits', async () => {
  const { preflightImages } = await modulePromise, { fixtureBlob } = await fixtures
  const record = { id: 'original', blob: fixtureBlob('png') }, old = record.blob, pending = preflightImages([record])
  record.id = 'changed'; record.blob = fixtureBlob('large'); const p = await pending
  assert.equal(p.items[0].id, 'original'); assert.equal(p.items[0].blob, old); assert(Object.isFrozen(p.items[0])); assert(Object.isFrozen(p.items)); assert(Object.isFrozen(p))
})
test('exact JSON depth64 and 20000 nodes accepted, next value rejected', async () => {
  const { inspectDocuments } = await modulePromise; let root = null
  for (let i = 0; i < 64; i++) root = [root]
  assert.equal((await inspectDocuments([root])).nodes, 65)
  assert.equal((await inspectDocuments([Array(19999).fill(null)])).nodes, 20000)
  await rejection(inspectDocuments([Array(20000).fill(null)]), 'DOCUMENT_NODE_LIMIT')
})
test('surrogate-pair strings with odd offset still yield cooperatively', async () => {
  const { inspectDocuments } = await modulePromise, c = new AbortController(); let clock = 0, yields = 0
  await rejection(inspectDocuments(['x' + '🌿'.repeat(500000)], { signal: c.signal, now: () => ++clock, yieldTask: async () => { yields++; c.abort() } }), 'CANCELLED'); assert.equal(yields, 1)
})
test('serial decode accepts JPEG EXIF-style swapped dimensions but closes result', async () => {
  const { preflightImages, SerialImageDecoder } = await modulePromise, { fixtureBlob } = await fixtures
  const p = await preflightImages([{ id: 'jpeg', blob: fixtureBlob('jpeg') }]), b = bitmap(384, 512), q = new SerialImageDecoder()
  assert.equal((await q.run(p, { decode: async () => b })).completed, 1); assert.equal(b.closed, 1)
})
test('new resource route remains allowlisted; no private API or object URL use', () => {
  const { allowed } = require('../tools/print-lab/serve.cjs'), fs = require('node:fs'), path = require('node:path')
  for (const name of ['resource-lab.html', 'resource-lab.css', 'resource-lab.mjs', 'resource-budget.mjs', 'resource-fixtures.mjs']) assert(allowed('/frontend/tools/print-lab/' + name))
  for (const file of ['resource-budget.mjs', 'resource-lab.mjs']) {
    const s = fs.readFileSync(path.join(__dirname, '../tools/print-lab/', file), 'utf8')
    assert(!/\b(?:fetch|XMLHttpRequest|indexedDB|localStorage|sessionStorage|createObjectURL)\s*[.(]/.test(s))
  }
  assert(!allowed('/frontend/src/db/schema.ts')); assert(!allowed('/api/media'))
})
