import { preflightImages, SerialImageDecoder, inspectDocuments, RESOURCE_LIMITS } from './resource-budget.mjs'
import { fixtureBlob } from './resource-fixtures.mjs'
const start = document.querySelector('#start'), cancel = document.querySelector('#cancel'), status = document.querySelector('#status'), checks = document.querySelector('#checks'), result = document.querySelector('#result'), canvas = document.querySelector('#preview'), ctx = canvas.getContext('2d')
const queue = new SerialImageDecoder(), pause = ms => new Promise(r => setTimeout(r, ms))
let controller, running = false
cancel.addEventListener('click', () => { controller?.abort(); status.textContent = '正在停止；迟到原生解码仍须释放，不能立刻开启另一批。' })
const assert = (value, label) => { if (!value) throw Error(label) }
const expect = async (work, code) => { try { await work(); throw Error(`未拒绝：${code}`) } catch (e) { if (e.code !== code) throw e } }
const bodyDoc = n => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(n) }] }] })
async function run() {
  if (running || queue.busy) return
  if (location.protocol !== 'http:' || location.hostname !== '127.0.0.1' || location.port !== '5184') { status.textContent = '停止：仅允许127.0.0.1:5184固定样张'; return }
  running = true; controller = new AbortController(); const signal = controller.signal
  start.disabled = true; cancel.disabled = false; checks.replaceChildren(); ctx.clearRect(0, 0, canvas.width, canvas.height)
  document.documentElement.dataset.complete = 'pending'
  const metrics = { calls: 0, active: 0, peak: 0, bitmaps: 0, closed: 0, live: 0, doubleClose: 0 }, results = [], input = {}
  const nativeDecode = async blob => {
    metrics.calls++; metrics.active++; metrics.peak = Math.max(metrics.peak, metrics.active)
    try {
      const source = await createImageBitmap(blob); metrics.bitmaps++; metrics.live++; let closed = false
      return { width: source.width, height: source.height, source, close() { if (closed) { metrics.doubleClose++; return }; closed = true; source.close(); metrics.closed++; metrics.live--; metrics.active-- } }
    } catch (error) { metrics.active--; throw error }
  }
  const check = () => { if (signal.aborted) { const e = Error('CANCELLED'); e.code = 'CANCELLED'; throw e } }
  const scenario = async (name, test) => {
    check(); status.textContent = `验证中：${name}`; await pause(0); check()
    const li = document.createElement('li'); li.textContent = name; checks.append(li)
    try { await test(); check(); li.textContent += '：通过'; li.dataset.state = 'passed'; results.push({ name, passed: true }) }
    catch (e) { li.textContent += `：停止 / ${e.code || e.message}`; li.dataset.state = 'failed'; results.push({ name, passed: false, code: e.code || e.message }); throw e }
  }
  let complete = false, error
  try {
    if (typeof createImageBitmap !== 'function') throw Error('当前浏览器缺少createImageBitmap，不自动换解码路线')
    const small = await preflightImages(['png', 'jpeg', 'webp'].map(id => ({ id, blob: fixtureBlob(id) })), { signal })
    await scenario('真实PNG/JPEG/WebP头部与逐张原生解码', async () => {
      const r = await queue.run(small, { signal, decode: nativeDecode }); assert(r.completed === 3 && metrics.peak === 1, '串行解码失败')
    })
    await scenario('重复引用只计一次，冲突ID明确拒绝', async () => {
      const blob = fixtureBlob('png'), p = await preflightImages([{ id: 'shared', blob }, { id: 'shared', blob }], { signal })
      assert(p.items.length === 1 && p.bytes === blob.size, '去重错误')
      await expect(() => preflightImages([{ id: 'x', blob }, { id: 'x', blob: fixtureBlob('jpeg') }], { signal }), 'AMBIGUOUS_IMAGE_REFERENCE')
    })
    await scenario('实际三张800万像素，总计2400万，逐张解码并关闭', async () => {
      const blob = fixtureBlob('large'), plan = await preflightImages([1, 2, 3].map(n => ({ id: `L${n}`, blob })), { signal })
      input.pixels = plan.pixels; input.uniqueCompressedBytes = plan.bytes
      const r = await queue.run(plan, { signal, decode: nativeDecode, onDecoded: b => { ctx.clearRect(0, 0, 512, 256); ctx.drawImage(b.source, 0, 0, 512, 256) } })
      assert(r.completed === 3 && plan.pixels === 24000000 && metrics.peak === 1 && metrics.live === 0, '像素/回收错误')
    })
    await scenario('超单图像素、长边及总像素在解码前拒绝', async () => {
      const before = metrics.calls, blob = fixtureBlob('large'), bytes = new Uint8Array(await blob.arrayBuffer())
      new DataView(bytes.buffer).setUint32(16, 4001)
      await expect(() => preflightImages([{ id: 'one-over', blob: new Blob([bytes], { type: 'image/png' }) }], { signal }), 'IMAGE_PIXEL_LIMIT')
      new DataView(bytes.buffer).setUint32(16, 100000)
      await expect(() => preflightImages([{ id: 'huge', blob: new Blob([bytes], { type: 'image/png' }) }], { signal }), 'IMAGE_DIMENSION_LIMIT')
      await expect(() => preflightImages([1, 2, 3, 4].map(n => ({ id: String(n), blob })), { signal }), 'TOTAL_PIXEL_LIMIT')
      assert(metrics.calls === before, '超限后仍解码')
    })
    await scenario('单文件与去重媒体字节、张数保护', async () => {
      const before = metrics.calls, big = new Blob([new Uint8Array(12 * 1024 ** 2 + 1)], { type: 'image/png' })
      await expect(() => preflightImages([{ id: 'big', blob: big }], { signal }), 'IMAGE_BYTE_LIMIT')
      const blob = new Blob([new Uint8Array(12 * 1024 ** 2)], { type: 'image/png' })
      await expect(() => preflightImages(Array.from({ length: 6 }, (_, i) => ({ id: String(i), blob })), { signal }), 'MEDIA_BYTE_LIMIT')
      await expect(() => preflightImages(Array.from({ length: 101 }, (_, i) => ({ id: String(i), blob: fixtureBlob('webp') })), { signal }), 'IMAGE_COUNT_LIMIT')
      assert(metrics.calls === before, '字节超限后仍解码')
    })
    await scenario('动画PNG/WebP及GIF/SVG不静默丢弃', async () => {
      for (const name of ['apng', 'animatedWebp']) await expect(() => preflightImages([{ id: name, blob: fixtureBlob(name) }], { signal }), 'ANIMATED_IMAGE_UNSUPPORTED')
      for (const type of ['image/gif', 'image/svg+xml']) await expect(() => preflightImages([{ id: type, blob: new Blob(['public'], { type }) }], { signal }), 'UNSUPPORTED_IMAGE_TYPE')
    })
    await scenario('头部可读但压缩流损坏，原生解码失败后释放队列', async () => {
      const p = await preflightImages([{ id: 'corrupt', blob: fixtureBlob('corrupt') }], { signal })
      await expect(() => queue.run(p, { signal, decode: nativeDecode }), 'IMAGE_DECODE_FAILED'); await pause(0); assert(!queue.busy, '失败未释放队列')
    })
    await scenario('真实4MiB正文JSON边界与多1字节拒绝', async () => {
      const overhead = JSON.stringify(bodyDoc(0)).length, d = bodyDoc(4 * 1024 ** 2 - overhead)
      input.document = await inspectDocuments([d], { signal }); assert(input.document.bytes === 4 * 1024 ** 2, '字节计量错误')
      await expect(() => inspectDocuments([bodyDoc(4 * 1024 ** 2 - overhead + 1)], { signal }), 'DOCUMENT_BYTE_LIMIT')
    })
    await scenario('真实100篇与101篇拒绝；深度/节点上限拒绝', async () => {
      input.hundred = await inspectDocuments(Array.from({ length: 100 }, () => bodyDoc(8)), { signal })
      await expect(() => inspectDocuments(Array(101).fill(null), { signal }), 'ENTRY_COUNT_LIMIT')
      let deep = null; for (let i = 0; i < 66; i++) deep = [deep]
      await expect(() => inspectDocuments([deep], { signal }), 'DOCUMENT_DEPTH_LIMIT')
      await expect(() => inspectDocuments([Array(20000).fill(null)], { signal }), 'DOCUMENT_NODE_LIMIT')
    })
    await scenario('真实大正文合作式取消，不发布半份计量结果', async () => {
      const c = new AbortController(), timer = setTimeout(() => c.abort(), 5)
      try { await expect(() => inspectDocuments([bodyDoc(4 * 1024 ** 2 - 100)], { signal: c.signal }), 'CANCELLED') } finally { clearTimeout(timer) }
    })
    await scenario('模拟迟到：真实解码后延迟结果，取消仍占槽且关闭迟到图', async () => {
      const c = new AbortController(); let called
      const launched = new Promise(r => { called = r }), p = queue.run(small, { signal: c.signal, decode: async blob => { called(); const b = await nativeDecode(blob); await pause(40); return b }, onDecoded: () => { throw Error('迟到图不应发布') } })
      await launched; c.abort(); await expect(() => p, 'CANCELLED'); assert(queue.busy, '提前释放原生解码槽')
      await expect(() => queue.run(small), 'DECODER_BUSY')
      while (queue.busy) { check(); await pause(10) }; assert(metrics.live === 0, '迟到图未关闭')
    })
    await scenario('模拟迟到：10ms等待截止，不冒充已中断浏览器解码', async () => {
      const p = queue.run(small, { signal, timeoutMs: 10, decode: async blob => { const b = await nativeDecode(blob); await pause(40); return b } })
      await expect(() => p, 'DECODE_TIMEOUT'); assert(queue.busy, '超时提前释放槽')
      while (queue.busy) { check(); await pause(10) }; assert(metrics.live === 0, '超时迟到图未关闭')
    })
    assert(metrics.active === 0 && metrics.live === 0 && metrics.closed === metrics.bitmaps && metrics.doubleClose === 0 && metrics.peak === 1, '最终资源/并发不守恒')
    complete = true; status.textContent = `固定材料验证完成：${results.length}项通过；解码峰值并发1，位图全部关闭。`
  } catch (e) { error = e.code || e.message; status.textContent = `停止：${error}。未将半份结果判为通过。`; ctx.clearRect(0, 0, 512, 256) }
  finally {
    cancel.disabled = true
    const report = { complete, scope: '真实浏览器Blob/头部/原生ImageBitmap与固定大正文；非生产DB/完整打印', results, metrics, input, limits: RESOURCE_LIMITS, queueBusy: queue.busy, cleanupComplete: metrics.active === 0 && metrics.live === 0, error, limitations: ['迟到取消与超时用真实解码+固定延迟模拟，未验证原生永久挂起', '未测真实手机/百页排版/PDF图片累计解码峰值内存', 'GIF/动画/SVG为本原型显式阻塞，P6产品降级策略须冻结；P5支持不变', '这里只计已经加载的固定正文，不证明数据库快照加载有界'] }
    result.textContent = JSON.stringify(report, null, 2); document.documentElement.dataset.complete = String(complete); running = false
    if (!queue.busy) start.disabled = false
    else { const began = performance.now(), timer = setInterval(() => { if (!queue.busy || performance.now() - began > 30000) { clearInterval(timer); start.disabled = queue.busy; report.queueBusy = queue.busy; report.cleanupComplete = metrics.active === 0 && metrics.live === 0; result.textContent = JSON.stringify(report, null, 2); if (!queue.busy) status.textContent = `已停止：${error}；迟到位图已回收，未发布成功结果。` } }, 100) }
  }
}
start.addEventListener('click', run)
if (new URLSearchParams(location.search).get('run') === '1') run()
