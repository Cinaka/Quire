import Dexie from 'dexie'
import { createExportPreflightTask } from '../../src/shared/exportPreflightTask.ts'
import { SerialImageDecoder, exportImageDecoder } from '../../src/shared/exportImageResources.ts'
import { createLocalExportSnapshotPort } from '../../src/db/exportSnapshotRepo.ts'
import { db, writer, OWNER, EPOCH, changeAuth, resetAuth } from './store.mjs'
import { subscriptions } from './dexie-probe.mjs'
import { entry, content, image, png, versionEntry, versionTag, MEDIA, THUMB, MISSING, UNUSED } from './fixtures.mjs'

const all = { scope: { kind: 'all' } }
const one = { scope: { kind: 'entry', id: 'fixed-01' } }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
function assert(value, message) { if (!value) throw Error(message) }
const hex = buffer => [...new Uint8Array(buffer)].map(x => x.toString(16).padStart(2, '0')).join('')
const digest = async blob => hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))
async function canonical(value) {
  if (value instanceof Blob) return { type: value.type, size: value.size, sha256: await digest(value) }
  if (Array.isArray(value)) return Promise.all(value.map(canonical))
  if (value && typeof value === 'object') {
    const result = {}
    for (const key of Object.keys(value).sort()) result[key] = await canonical(value[key])
    return result
  }
  return value
}
async function fingerprint() {
  // Fixed-fixture audit only, not the production candidate scanner. Hash AFTER commit.
  const rows = await writer.transaction('r!', writer.tables, async () => {
    const result = {}
    for (const table of writer.tables) result[table.name] = await table.orderBy(':id').toArray()
    return result
  })
  return JSON.stringify(await canonical(rows))
}
async function expectCode(work, expected) {
  try { await work() } catch (error) { assert(error.code === expected, `应拒绝${expected}，实际${error.code ?? error.name}`); return }
  throw Error(`未拒绝：${expected}`)
}
export async function run({ signal, opened, networkAttempts }) {
  const status = document.querySelector('#status'), output = document.querySelector('#report'), list = document.querySelector('#checks'), preview = document.querySelector('#snapshot')
  const report = {
    scope: '真实Dexie/IndexedDB与未修改的生产快照适配器；模拟身份/owner读取与固定材料；非正式入口',
    database: db.name, browser: navigator.userAgent, complete: false, results: [],
    opened, networkAttempts, productionWriteAttempts: [], fixtureWriteOperations: [],
    imageDecodeCalls: 0, imageDecodePeak: 0, bitmapsCreated: 0, bitmapsClosed: 0, contentSubscriptionsRemaining: null,
    dataTransactions: [], readonlyWriteProbeDenials: 0, subscriptionsRemaining: null, objectUrlAttempts: 0,
    limitations: ['没有调用/auth/me、验证JWT签名或正式账号生命周期；lease只在隔离测试中固定供应',
      '生产适配器的DB/token/owner依赖被定向替换；Dexie、实际schema、只读事务及liveQuery是真实的',
      '并发写入由原生游标调用点调度另一连接；任务替换/取消也由受控读调用点触发，非真实用户竞态',
      '新增真实2x2 PNG快照到事务外原生解码和变化提示核验；失败/迟到由受控注入，不是原生损坏必拒承诺',
      '降级选择是固定材料下的程序显式调用，不是实际点击正式界面，不验证私人内容确认',
      '没有验证正式账号变化提示界面、全尺寸图片组合、字体、分页、系统打印或手机内存'],
  }
  const ports = [], tasks = [], audit = { enabled: false, transactions: [], reads: [], hook: null }
  let task = 0, currentView, unexpectedError, runningCase = 'initialization'
  const pendingWriters = []
  const renderReport = () => { output.textContent = JSON.stringify(report, null, 2) }
  function checkpoint() { if (signal.aborted) throw Object.assign(Error('已停止，不计通过'), { code: 'CANCELLED' }) }
  async function until(condition, message) {
    const end = Date.now() + 12000
    while (Date.now() < end) { checkpoint(); if (condition()) return; await pause(30) }
    throw Error(`超时：${message}；请保持页面前台，排除后台节流后再核对`)
  }
  function clearView(text = '当前快照已释放。') { task++; currentView = undefined; preview.textContent = text }
  function closeAll() { clearView(); for (const task of tasks) task.close(); for (const port of ports) port.close() }
  const onAbort = () => { audit.hook = null; closeAll() }
  signal.addEventListener('abort', onAbort, { once: true })
  const createURL = URL.createObjectURL
  URL.createObjectURL = () => { report.objectUrlAttempts++; throw Error('此快照层不应创建Object URL') }
  function port() {
    const p = createLocalExportSnapshotPort({ ownerUserId: OWNER, generation: EPOCH, authGeneration: 1 })
    ports.push(p); return p
  }
  async function display(p, handle) {
    const token = ++task
    const model = await handle.read()
    checkpoint()
    if (token !== task) return
    currentView = handle
    preview.textContent = `固定快照：${model.entries.length}篇 / ${model.media.length}项图片引用\n${model.entries[0]?.title ?? '空范围'}\n仅固定材料；不代表正式预览。`
    p.subscribeInvalidated(() => { if (currentView === handle) clearView('身份或本机归属已失效；固定快照展示已清空。') })
  }
  function observeReads(name, request) {
    if (!audit.enabled) return
    audit.reads.push({ table: name, trans: request.trans })
    if (audit.hook) audit.hook(name, request)
  }
  db.use({ stack: 'dbcore', name: 'p6-real-snapshot-audit', create: down => ({
    ...down,
    transaction(stores, mode, options) {
      const trans = down.transaction(stores, mode, options)
      if (audit.enabled) audit.transactions.push({ stores: [...stores], mode, trans })
      return trans
    },
    table(name) {
      const lower = down.table(name), wrapped = { ...lower }
      for (const method of ['get', 'getMany', 'query', 'openCursor', 'count']) if (typeof lower[method] === 'function') {
        wrapped[method] = request => { observeReads(name, request); return lower[method](request) }
      }
      wrapped.mutate = request => { if (audit.enabled) report.productionWriteAttempts.push({ table: name, type: request.type }); return lower.mutate(request) }
      return wrapped
    },
  }) })
  writer.use({ stack: 'dbcore', name: 'p6-fixture-writer-audit', create: down => ({ ...down, table(name) {
    const lower = down.table(name)
    return { ...lower, mutate(request) { report.fixtureWriteOperations.push({ scenario: runningCase, table: name, type: request.type, records: request.values?.length ?? request.keys?.length ?? 0 }); return lower.mutate(request) } }
  } }) })
  const assertNoWrites = async before => {
    assert(report.productionWriteAttempts.length === 0, '生产快照路径出现写入尝试')
    assert(await fingerprint() === before, '快照读取改变了实际库内容（包含Blob字节）')
  }
  async function writeVersion(version) {
    await writer.transaction('rw!', writer.entries, writer.tags, writer.media, async () => {
      await writer.entries.put(versionEntry(version)); await writer.tags.put(versionTag(version)); await writer.media.put(image(MEDIA, png(version)))
    })
  }
  async function verifyVersion(model, version) {
    const e = model.entries.find(row => row.id === 'fixed-01')
    assert(e?.title === `version-${version}`, '标题混版本')
    assert(JSON.stringify(e.content.nodes).includes(`BODY_${version}`), '正文混版本')
    assert(e.tags[0]?.name === `TAG_${version}`, '标签混版本')
    assert(await digest(model.media.find(row => row.id === MEDIA).blob) === await digest(png(version)), '图片字节混版本')
  }
  async function check(name, work) {
    checkpoint(); runningCase = name; status.textContent = `验证中：${name}`
    const item = document.createElement('li'); item.textContent = `${name}：进行中`; list.append(item)
    try {
      await work(); checkpoint(); report.results.push({ name, passed: true }); item.className = 'passed'; item.textContent = `${name}：通过`
    } catch (error) {
      report.results.push({ name, passed: false, code: error.code ?? error.name, error: error.message }); item.className = 'failed'; item.textContent = `${name}：停止 / ${error.code ?? error.message}`; throw error
    } finally { renderReport() }
  }
  try {
    checkpoint(); assert(document.visibilityState === 'visible', '请保持测试页面在前台')
    document.querySelector('#empty')?.remove()
    assert(db.name.startsWith('quire-p6-snapshotcheck-') && writer.name === db.name, '非本次隔离库')
    await db.open(); await writer.open()
    await writer.transaction('rw!', writer.tables, async () => {
      await writer.entries.bulkAdd([
        ...Array.from({ length: 37 }, (_, n) => n === 1 ? versionEntry('old') : entry(n)),
        entry(90, { isDeleted: 1 }), entry(91, { deletedAt: '2026-10-21T01:00:00Z' }),
        entry(92, { entryDate: '2026-09-30' }),
      ])
      await writer.tags.add(versionTag('old'))
      await writer.media.bulkAdd([image(MEDIA), image(THUMB, new Blob([], { type: 'image/png' }), { thumbBlob: png('old') }), image(UNUSED)])
      await writer.meta.bulkAdd([{ key: 'ownerUserId', value: OWNER }, { key: 'ownerGeneration', value: EPOCH }, { key: 'syncCursor', value: 'FIXED_SENTINEL' }])
      await writer.schedules.add({ id: 'not-an-entry', remindDate: '2026-10-21', status: 'pending', title: 'PRIVATE_SCHEDULE_MUST_NOT_ESCAPE', updatedAt: '2026-10-21T00:00:00Z', dirty: 1, isDeleted: 0 })
    })
    audit.enabled = true
    const before = await fingerprint()
    await check('真实游标与同一只读事务：37篇、不截20、正文标签图片同版本', async () => {
      audit.transactions.length = 0; audit.reads.length = 0
      const p = port(), h = await p.capture({ scope: { kind: 'month', month: '2026-10' } }), model = await h.read()
      assert(model.entries.length === 37, '范围成员错误或被20条截断')
      assert(model.entries[0].id === 'fixed-36' && model.entries.at(-1).id === 'fixed-00', '固定排序错误')
      await verifyVersion(model, 'old'); assert(model.completeOutputReady === false, '快照不能直接标记完整输出就绪')
      const data = audit.transactions.filter(row => ['meta', 'entries', 'tags', 'media'].every(name => row.stores.includes(name)))
      assert(data.length === 1 && data[0].mode === 'readonly' && data[0].stores.length === 4, '不是唯一四表物理只读事务')
      const relevant = audit.reads.filter(row => ['entries', 'tags', 'media'].includes(row.table))
      assert(relevant.length > 0 && relevant.every(row => row.trans === data[0].trans), '正文/标签/图片跨事务混读')
      report.dataTransactions.push({ stores: data[0].stores, mode: data[0].mode, sameNativeTransaction: true })
      const serialized = JSON.stringify(model)
      for (const secret of ['PRIVATE_PROVENANCE', 'PRIVATE_SCHEDULE', 'private-cloud', '"dirty":', '"ownerUserId":']) assert(!serialized.includes(secret), '私有来源字段逃逸')
      await display(p, h); await assertNoWrites(before); p.close()
    })
    await check('真实readonly拒绝写入：唯一显式原生写探针被拒绝且库不变', async () => {
      let probed = false
      audit.hook = (name, request) => {
        if (probed || name !== 'entries') return
        probed = true; audit.hook = null
        assert(request.trans.mode === 'readonly', '原生事务不是readonly')
        try { request.trans.objectStore('meta').put({ key: 'must-not-write', value: 'denied' }) }
        catch (error) { assert(error.name === 'ReadOnlyError', `意外拒绝类型${error.name}`); report.readonlyWriteProbeDenials++; return }
        throw Error('原生写探针未被readonly拒绝')
      }
      const p = port(), h = await p.capture(one); assert(probed, '没有触发原生只读探针'); h.release(); p.close(); await assertNoWrites(before)
    })
    await check('真实筛选、双软删标记及仅引用媒体：缩略图/缺失明确诊断', async () => {
      await writer.entries.put(entry(2, { tagIds: ['missing-tag'], content: content('固定图片诊断', [THUMB, MISSING]) }))
      const state = await fingerprint(), p = port(), h = await p.capture({ scope: { kind: 'entry', id: 'fixed-02' } }), model = await h.read()
      assert(model.media.length === 2 && !model.media.some(row => row.id === UNUSED), '读取无引用媒体')
      assert(model.diagnostics.some(row => row.code === 'TAG_MISSING') && model.diagnostics.some(row => row.code === 'IMAGE_MISSING') && model.diagnostics.some(row => row.code === 'IMAGE_THUMBNAIL_ONLY'), '缺失/降级诊断遗漏')
      const soft = await p.capture({ scope: { kind: 'entry', id: 'fixed-91' } }); assert((await soft.read()).entries.length === 0, 'deletedAt未排除')
      const filtered = await p.capture({ scope: { kind: 'month', month: '2026-10' }, filters: { keyword: 'body_', tagIds: ['fixed-tag'], hasImage: true } }); assert((await filtered.read()).entries.length === 1, 'AND筛选错误')
      await assertNoWrites(state); p.close()
    })
    await check('快照后显式并发修改：旧正文/标签/Blob冻结，不悄悄换书', async () => {
      const p = port(), h = await p.capture(one), old = await h.read()
      await writeVersion('new'); await until(() => h.hasChanges(), '真实提交触发保守变化提示'); await verifyVersion(await h.read(), 'old')
      assert(Object.isFrozen(old.entries[0].content.nodes), '正文呈现值未冻结')
      const next = await p.capture(one); await verifyVersion(await next.read(), 'new'); await expectCode(() => h.read(), 'EXPORT_SNAPSHOT_RELEASED')
      next.release(); p.close()
    })
    await check('两连接真实竞争：游标读取期间排队原子更新，不混正文标签图片', async () => {
      await writeVersion('old')
      const p = port(); let queued = false, update
      audit.hook = name => {
        if (queued || name !== 'entries') return
        queued = true; audit.hook = null
        update = Dexie.ignoreTransaction(() => writeVersion('new'))
        // Do not await a write or any timer inside the snapshot read transaction.
        pendingWriters.push(update); void update.catch(() => {})
      }
      const h = await p.capture(one), model = await h.read()
      assert(queued && update, '未从实际游标/读取调用点调度另一连接更新')
      await update; checkpoint(); await verifyVersion(model, 'old')
      const next = await p.capture(one); await verifyVersion(await next.read(), 'new'); p.close()
    })
    await check('真实读取中取消：不发布半份，后续任务仍可读取', async () => {
      const p = port(), controller = new AbortController(); let triggered = false
      audit.hook = name => { if (!triggered && name === 'entries') { triggered = true; audit.hook = null; controller.abort() } }
      await expectCode(() => p.capture(one, controller.signal), 'EXPORT_CANCELLED'); assert(triggered, '没有在读取调用点取消')
      const next = await p.capture(one); await verifyVersion(await next.read(), 'new'); p.close()
    })
    await check('真实读取中任务替换：旧任务迟到拒绝，新任务不被清除', async () => {
      const p = port(); let newer
      audit.hook = name => {
        if (name !== 'entries' || newer) return
        audit.hook = null
        newer = Dexie.ignoreTransaction(() => p.capture({ scope: { kind: 'entry', id: 'fixed-03' } }))
      }
      await expectCode(() => p.capture(one), 'EXPORT_TASK_REPLACED')
      assert(newer, '未触发新任务'); const h = await newer; assert((await h.read()).entries[0]?.id === 'fixed-03', '新任务被旧任务清理'); p.close()
    })
    await check('发布后取消与close：句柄不可再读，受控展示清空', async () => {
      const p = port(), controller = new AbortController(), h = await p.capture(one, controller.signal)
      await display(p, h); controller.abort(); await expectCode(() => h.read(), 'EXPORT_SNAPSHOT_RELEASED')
      // Handle release does not itself render UI. The controller must clear its view.
      clearView('取消后已清空固定快照。'); assert(!currentView, '受控展示仍持有句柄')
      const h2 = await p.capture(one); await display(p, h2); p.close(); p.close(); await expectCode(() => h2.read(), 'EXPORT_SNAPSHOT_RELEASED'); assert(!currentView, 'close未通知清理展示')
    })
    await check('真实meta代际写入与liveQuery：旧端口失效、展示及订阅清理', async () => {
      const p = port(), h = await p.capture(one)
      p.subscribeInvalidated(() => { throw Error('固定消费者故障') })
      await display(p, h)
      await writer.meta.put({ key: 'ownerGeneration', value: 'explicit-fixture-restore-epoch' })
      await until(() => !currentView, 'liveQuery触发代际失效并清屏')
      await expectCode(() => h.read(), 'EXPORT_SNAPSHOT_RELEASED')
      await writer.meta.put({ key: 'ownerGeneration', value: EPOCH })
    })
    await check('模拟账号/令牌代际/过期：真实端口最终复核并释放', async () => {
      for (const change of [{ subject: 'B' }, { generation: 2 }, { expiresAt: 1 }]) {
        resetAuth(); const p = port(), h = await p.capture(one); await display(p, h)
        changeAuth(change); await expectCode(() => p.assertCurrent(), 'EXPORT_CONTEXT_EXPIRED'); await expectCode(() => h.read(), 'EXPORT_SNAPSHOT_RELEASED'); assert(!currentView, '模拟身份变化后仍展示旧快照')
      }
      resetAuth()
    })
    let decoding = 0
    async function trackedDecode(blob) {
      assert(!Dexie.currentTransaction, '原生解码进入了数据库事务')
      report.imageDecodeCalls++; decoding++; report.imageDecodePeak = Math.max(report.imageDecodePeak, decoding)
      let native
      try { native = await createImageBitmap(blob) } catch (error) { decoding--; throw error }
      report.bitmapsCreated++; let disposed = false
      return { width: native.width, height: native.height, close() {
        assert(!disposed, '位图重复关闭'); disposed = true; native.close(); report.bitmapsClosed++; decoding--
      } }
    }
    await check('真实快照到事务外图片预检：原生解码关闭，变化仅提示，重新捕获才更新', async () => {
      const p = port(), task = createExportPreflightTask(p, { decode: trackedDecode }); tasks.push(task)
      await task.run(one, signal); const old = await task.read()
      assert(old.images.pixels === 4 && old.images.items.length === 1 && !old.completeOutputReady, '固定PNG资源或完整就绪状态错误')
      assert(old.snapshot.entries[0].title === 'version-new', '初始快照不是当前固定版本')
      await writeVersion('old'); await until(() => task.status().changed, '真实提交驱动任务变化提示')
      assert((await task.read()).snapshot === old.snapshot && (await task.read()).changed, '提示时悄悄替换了冻结内容')
      preview.textContent = '固定材料已有变化；保留旧快照，仅明确重新捕获才更新。'
      await task.run(one, signal); const next = await task.read()
      assert(next.snapshot.entries[0].title === 'version-old', '明确重捕获未取得新版本')
      // A delayed committed notice may conservatively remain true; never auto-clear based on content equality.
      task.cancel(); await expectCode(() => task.read(), 'EXPORT_PREFLIGHT_NOT_CHECKED')
      task.close(); p.close(); clearView()
      assert(!exportImageDecoder.busy, '正常任务结束后解码槽未释放')
    })
    await check('注入单图解码失败诊断默认阻断完整版，重捕获及真实meta失效', async () => {
      const p = port(), task = createExportPreflightTask(p, { decode: async () => { throw Error('明确注入的解码失败，不是原生损坏结论') } }); tasks.push(task)
      await task.run(one, signal); const failedImage = await task.read()
      assert(failedImage.review.issues.some(issue => issue.code === 'IMAGE_DECODE_FAILED') && failedImage.images.items.length === 0, '注入单图失败未形成明确诊断')
      await expectCode(() => task.readForLayout('full', failedImage.review), 'EXPORT_FULL_CONTENT_BLOCKED')
      await expectCode(() => task.readForLayout('degraded', failedImage.review), 'EXPORT_DEGRADED_CONFIRMATION_REQUIRED')
      await until(() => !exportImageDecoder.busy, '失败后解码槽释放'); task.close(); p.close()
      const currentPort = port(), current = createExportPreflightTask(currentPort, { decode: trackedDecode }); tasks.push(current)
      await current.run(one, signal); await current.read()
      await writer.meta.put({ key: 'ownerGeneration', value: 'fixture-preflight-epoch' })
      await until(() => current.status().state === 'closed', '真实代际变化关闭预检任务')
      await expectCode(() => current.read(), 'EXPORT_PREFLIGHT_NOT_CHECKED')
      await writer.meta.put({ key: 'ownerGeneration', value: EPOCH })
    })
    await check('真实解码后模拟迟到：取消不提前释放唯一槽，迟到位图关闭后才重试', async () => {
      const p = port(), queue = new SerialImageDecoder(); let lateReady = false, releaseLate, holdLate = true
      const task = createExportPreflightTask(p, { decoder: queue, decode: async blob => {
        const bitmap = await trackedDecode(blob)
        if (!holdLate || signal.aborted) return bitmap
        lateReady = true
        return new Promise(resolve => { releaseLate = () => { releaseLate = undefined; resolve(bitmap) } })
      } }); tasks.push(task)
      const pending = task.run(one, signal); void pending.catch(() => {})
      try {
        await until(() => lateReady, '真实原生解码完成并进入受控迟到'); task.cancel()
        await expectCode(() => pending, 'CANCELLED'); assert(queue.busy, '取消提前释放了迟到位图的唯一槽')
        await expectCode(() => task.run(one, signal), 'DECODER_BUSY')
        releaseLate(); await until(() => !queue.busy, '迟到位图关闭释放槽')
        task.close(); p.close()
        const retryPort = port(), retry = createExportPreflightTask(retryPort, { decoder: queue, decode: trackedDecode }); tasks.push(retry)
        await retry.run(one, signal); await retry.read(); retry.close(); retryPort.close()
      } finally { holdLate = false; releaseLate?.(); task.close(); p.close() }
      assert(report.bitmapsCreated === report.bitmapsClosed && decoding === 0, '位图没有全部关闭')
    })
    await check('真实快照诊断汇总：缺图/缩略/缺标签，默认阻断与内部显式降级选择', async () => {
      const p = port(), task = createExportPreflightTask(p, { decode: trackedDecode }); tasks.push(task)
      await task.run({ scope: { kind: 'entry', id: 'fixed-02' } }, signal)
      const value = await task.read(), review = value.review
      assert(review.issueCount === 3 && review.affectedEntryCount === 1 && review.affectedImageCount === 2, '篇目/问题/去重图片计数错误')
      assert(review.state === 'requires-degraded-confirmation' && !value.degradedConfirmed && !value.completeOutputReady, '默认策略错误')
      await expectCode(() => task.readForLayout('full', review), 'EXPORT_FULL_CONTENT_BLOCKED')
      await expectCode(() => task.readForLayout('degraded', review), 'EXPORT_DEGRADED_CONFIRMATION_REQUIRED')
      await expectCode(() => task.confirmDegraded({ ...review }), 'EXPORT_STALE_REVIEW')
      // Programmatic action in isolated fixture, NOT a human confirmation of private content.
      await task.confirmDegraded(review)
      const selected = await task.readForLayout('degraded', review)
      assert(selected.contentMode === 'degraded' && !selected.completeOutputReady, '诊断确认误称完整打印就绪')
      task.revokeDegraded(); await expectCode(() => task.readForLayout('degraded', review), 'EXPORT_DEGRADED_CONFIRMATION_REQUIRED')
      task.close(); p.close()
    })
    await check('相同诊断跨任务不复用确认，取消/重捕获后旧确认不可复活', async () => {
      const a = port(), b = port(), first = createExportPreflightTask(a, { decode: trackedDecode }), second = createExportPreflightTask(b, { decode: trackedDecode }); tasks.push(first, second)
      const request = { scope: { kind: 'entry', id: 'fixed-02' } }
      await first.run(request, signal); await second.run(request, signal)
      const ar = (await first.read()).review, br = (await second.read()).review
      assert(JSON.stringify(ar) === JSON.stringify(br), '固定相同诊断材料不一致')
      await expectCode(() => first.confirmDegraded(br), 'EXPORT_STALE_REVIEW')
      await first.confirmDegraded(ar); first.cancel()
      await expectCode(() => first.readForLayout('degraded', ar), 'EXPORT_PREFLIGHT_NOT_CHECKED')
      await expectCode(() => second.readForLayout('degraded', br), 'EXPORT_DEGRADED_CONFIRMATION_REQUIRED')
      await second.confirmDegraded(br); await second.run(one, signal)
      const current = await second.read()
      assert(!current.degradedConfirmed && current.review.state === 'full-content-available', '新快照保留旧确认')
      await expectCode(() => second.confirmDegraded(br), 'EXPORT_STALE_REVIEW')
      assert(!(await second.readForLayout('full', current.review)).completeOutputReady, '内容可用不等于字体/分页/打印就绪')
      first.close(); second.close(); a.close(); b.close()
    })
    await check('最终只读与资源清理：无API/云媒体、Object URL或剩余订阅', async () => {
      const state = await fingerprint(), p = port(), h = await p.capture(all); await display(p, h)
      closeAll(); await until(() => subscriptions.active === 0 && subscriptions.contentActive === 0, '真实liveQuery与内容监听归零'); await expectCode(() => h.read(), 'EXPORT_SNAPSHOT_RELEASED')
      await assertNoWrites(state)
      assert(report.objectUrlAttempts === 0 && networkAttempts.length === 0, '出现非预期URL或请求')
      const bad = performance.getEntriesByType('resource').filter(row => { const url = new URL(row.name, location.href); return url.origin !== location.origin || /^\/(?:api|media|uploads)(?:\/|$)/.test(url.pathname) })
      assert(bad.length === 0, '出现外网/API/云媒体请求')
      assert(opened.length > 0 && opened.every(name => name === db.name), '触及非测试库')
      const mutations = report.fixtureWriteOperations.map(row => `${row.table}:${row.type}:${row.records}`).sort()
      const expected = ['entries:add:40', 'tags:add:1', 'media:add:3', 'meta:add:3', 'schedules:add:1',
        ...Array(5).fill('entries:put:1'), ...Array(4).fill('tags:put:1'), ...Array(4).fill('media:put:1'), ...Array(4).fill('meta:put:1')].sort()
      assert(JSON.stringify(mutations) === JSON.stringify(expected), '夹具写入操作不符合明确白名单，不忽略额外写入')
      assert(report.readonlyWriteProbeDenials === 1, '原生拒写探针次数异常')
    })
  } catch (error) {
    unexpectedError = error; report.error = { code: error.code ?? error.name, message: error.message }
  } finally {
    audit.hook = null; closeAll()
    await Promise.allSettled(pendingWriters)
    signal.removeEventListener('abort', onAbort)
    report.subscriptionsRemaining = subscriptions.active
    report.contentSubscriptionsRemaining = subscriptions.contentActive
    report.subscriptionsCreated = subscriptions.created
    URL.createObjectURL = createURL
    db.close(); writer.close()
    report.databaseConnectionsClosed = !db.isOpen() && !writer.isOpen()
    report.complete = !unexpectedError && !signal.aborted && report.results.length === 16 && report.results.every(row => row.passed) && report.subscriptionsRemaining === 0 && report.contentSubscriptionsRemaining === 0 && report.bitmapsCreated === report.bitmapsClosed && report.imageDecodePeak === 1 && report.productionWriteAttempts.length === 0 && report.databaseConnectionsClosed
    status.textContent = report.complete
      ? '固定材料核验完成：16项通过。随机库连接已关闭，生产写入0，订阅0。不是正式导出验收。'
      : `未完成：${signal.aborted ? 'CANCELLED；不计通过' : (unexpectedError?.message ?? '清理条件不满足')}。`
    renderReport()
  }
  return report
}
