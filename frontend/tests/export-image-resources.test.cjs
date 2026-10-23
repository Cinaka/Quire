const { test } = require('node:test'), assert = require('node:assert/strict')
const modulePromise = Promise.resolve(require('../src/shared/exportImageResources.ts'))
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
test('native failure becomes blocker; post-close identity failure does not double-close bitmap', async () => {
 const {SerialImageDecoder}=await modulePromise,q=new SerialImageDecoder(),p=await smallPlan();
 await rejection(q.run(p,{decode:async()=>{throw Error('native')}}),'IMAGE_DECODE_FAILED'); await new Promise(setImmediate);
 const b=bitmap(); let n=0; await assert.rejects(q.run(p,{decode:async()=>b,assertCurrent:async()=>{if(++n===2)throw Error('expired')}}),{code:'IMAGE_DECODE_FAILED'});
 assert.equal(b.closed,1); assert.equal(q.busy,false)
})
test('real animation fixtures, oversized chunk and normalized MIME blocked or checked',async()=>{
 const {preflightImages}=await modulePromise,{fixtureBlob}=await fixtures;
 for(const id of ['apng','animatedWebp'])await rejection(preflightImages([{id,blob:fixtureBlob(id)}]),'ANIMATED_IMAGE_UNSUPPORTED');
 const b=new Uint8Array(await fixtureBlob('png').arrayBuffer()); new DataView(b.buffer).setUint32(33,0xffffffff);
 await rejection(preflightImages([{id:'bad',blob:new Blob([b],{type:'image/png'})}]),'INVALID_IMAGE_HEADER');
 assert.equal((await preflightImages([{id:'upper',blob:new Blob([await fixtureBlob('png').arrayBuffer()],{type:'IMAGE/PNG'})}])).items[0].width,512)
})
test('records detached before first assertCurrent await; auth/abort rechecked after blob read',async()=>{
 const {preflightImages}=await modulePromise,{fixtureBlob}=await fixtures,record={id:'old',blob:fixtureBlob('png')};
 let n=0; const result=preflightImages([record],{assertCurrent:async()=>{if(++n===1){record.id='new';record.blob=fixtureBlob('large')}}});
 assert.equal((await result).items[0].id,'old');
 const c=new AbortController(),b=fixtureBlob('png'); const original=b.arrayBuffer.bind(b); b.arrayBuffer=async()=>{const a=await original();c.abort();return a};
 await rejection(preflightImages([{id:'x',blob:b}],{signal:c.signal}),'CANCELLED')
})
test('production header outcomes match frozen lab corpus without relaxing accepted budgets',async()=>{
 const prod=await modulePromise,lab=await import('../tools/print-lab/resource-budget.mjs'),{fixtureBlob}=await fixtures;
 for(const id of ['png','jpeg','webp','large','apng','animatedWebp']){
  const b=fixtureBlob(id),a=await b.arrayBuffer(); let p,l;
  try{p=prod.inspectHeader(a,b.type)}catch(e){p=e.code}try{l=lab.inspectHeader(a,b.type)}catch(e){l=e.code}
  assert.deepEqual(p,l)
 }
})
test('JPEG orientation may swap dimensions; other bitmap mismatch closes and blocks',async()=>{
 const {SerialImageDecoder,preflightImages}=await modulePromise,{fixtureBlob}=await fixtures,q=new SerialImageDecoder();
 const plan=await preflightImages([{id:'j',blob:fixtureBlob('jpeg')}]),b=bitmap(384,512);
 await q.run(plan,{decode:async()=>b});assert.equal(b.closed,1)
 const bad=bitmap(513,384);await rejection(q.run(plan,{decode:async()=>bad}),'DECODE_DIMENSION_MISMATCH');assert.equal(bad.closed,1)
})
