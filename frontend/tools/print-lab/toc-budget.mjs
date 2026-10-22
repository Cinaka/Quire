import { assertBudget, settleToc, PrintLabError } from './print-guards.mjs'
const q = new URLSearchParams(location.search), kind = q.get('case') || 'normal', fallback = q.get('font') === 'fallback'
const output = document.querySelector('#output'), measure = document.querySelector('#measure'), status = document.querySelector('#status'), result = document.querySelector('#result'), cancel = document.querySelector('#cancel')
const controller = new AbortController(), signal = controller.signal
cancel.addEventListener('click', () => controller.abort())
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n }
const pause = () => new Promise(resolve => setTimeout(resolve, 0))
function check() { if (signal.aborted) throw new PrintLabError('CANCELLED') }
const entries = Array.from({ length: 9 }, (_, i) => ({
  id: `FIXED_${String(i + 1).padStart(2, '0')}`, date: `2026-10-${String(21 + i).padStart(2, '0')}`,
  title: `第${i + 1}简：` + '雨后记事，沿着纸页读过漫长的一天，仍保留长标题的每一个字。'.repeat(i % 2 ? 4 : 3) + `【标题终点${i + 1}】`,
  body: `固定公开校验正文，第${i + 1}篇。目录应指向本篇标题所在的逻辑页，不是目录纸面或拼版序号。`,
}))
const stats = { entries: entries.length, textBytes: new TextEncoder().encode(entries.map(e => e.title + e.body).join('')).length, mediaBytes: 0, logicalPages: 0, nodes: 0 }
function paper(title) {
  const p = el('section', undefined, 'paper'), body = el('div', undefined, 'body')
  if (title) body.append(el('p', 'CONTENTS / FIXED MATERIAL', 'date'), el('h2', title))
  p.append(body); measure.append(p); return p
}
const bodyOf = p => p.querySelector('.body')
function fits(p) {
  const b = bodyOf(p), last = b.lastElementChild
  return !last || (last.getBoundingClientRect().bottom <= b.getBoundingClientRect().bottom - .5 && b.scrollWidth <= b.clientWidth + 1)
}
function makeRow(entry, label) {
  const row = el('p', undefined, 'toc-row'), title = el('span', undefined, 'toc-title')
  title.append(el('span', entry.date, 'toc-date'), el('span', entry.title))
  row.dataset.id = entry.id; row.append(title, el('span', String(label), 'toc-page')); return row
}
async function run() {
  if (location.protocol !== 'http:' || location.hostname !== '127.0.0.1' || location.port !== '5184') throw new PrintLabError('WRONG_ORIGIN')
  if (!['normal', 'overlimit', 'cycle', 'cancel'].includes(kind)) throw new PrintLabError('UNKNOWN_CASE')
  assertBudget({ ...stats, entries: kind === 'overlimit' ? 101 : stats.entries })
  document.documentElement.classList.toggle('fallback', fallback)
  if (!fallback) {
    let timer
    try { await Promise.race([document.fonts.load('16px "Quire Notebook WenKai"', entries.map(e => e.title + e.body).join('') + '目录续杀青校验样张多页目录 · 固定长标题校验九篇固定公开材料，不读取私人日记。CONTENTS / FIXED MATERIALQUIRE / PRINT LAB0123456789'), new Promise((_, reject) => { timer = setTimeout(() => reject(new PrintLabError('FONT_TIMEOUT')), 12000) })]) }
    finally { clearTimeout(timer) }
    await document.fonts.ready
    if ([...document.fonts].some(f => f.status === 'error')) throw new PrintLabError('FONT_ERROR')
  }
  check()
  const cover = paper(); cover.classList.add('cover')
  bodyOf(cover).append(el('p', 'QUIRE / PRINT LAB', 'brand'), el('h2', '杀青'), el('p', '多页目录 · 固定长标题校验'), el('p', '九篇固定公开材料，不读取私人日记。'))
  const bodies = entries.map(entry => {
    const p = paper(), b = bodyOf(p)
    b.append(el('p', entry.date, 'date'), el('h2', entry.title, 'long-title'), el('p', entry.body), el('p', `BODY_END_${entry.id}`, 'end'))
    if (!fits(p)) throw new PrintLabError('FIXED_BODY_OVERFLOW')
    return p
  })
  let toc = [], calls = 0
  const convergence = await settleToc(entries.map((_, i) => i + 1), async labels => {
    calls++; check(); toc.forEach(p => p.remove()); toc = [paper('目录')]
    for (const [i, entry] of entries.entries()) {
      check(); let p = toc.at(-1), row = makeRow(entry, labels[i]); bodyOf(p).append(row)
      if (!fits(p)) { row.remove(); p = paper('目录 · 续'); toc.push(p); bodyOf(p).append(row) }
      if (!fits(p)) throw new PrintLabError('TOC_ROW_TOO_TALL')
      // Even 1/2/3-digit labels keep a reserved column without changing row geometry.
      const page = row.querySelector('.toc-page'), height = row.getBoundingClientRect().height
      for (const label of ['9', '10', '99', '100', '300']) {
        page.textContent = label
        if (page.scrollWidth > page.clientWidth + 1 || Math.abs(row.getBoundingClientRect().height - height) > .1) throw new PrintLabError('TOC_LABEL_OVERFLOW')
      }
      page.textContent = String(labels[i])
      await pause(); check()
    }
    return { pageCount: kind === 'cycle' ? (calls % 2 ? 2 : 1) : toc.length }
  }, { signal })
  check()
  const pages = [cover, ...toc, ...bodies], tocRows = toc.flatMap(p => [...p.querySelectorAll('.toc-row')])
  for (const [i, entry] of entries.entries()) {
    const row = tocRows[i]
    if (row.dataset.id !== entry.id || !row.querySelector('.toc-title').textContent.endsWith(entry.title) || Number(row.querySelector('.toc-page').textContent) !== pages.indexOf(bodies[i]) + 1) throw new PrintLabError('TOC_REFERENCE_MISMATCH')
  }
  if (pages.some(p => !fits(p))) throw new PrintLabError('PAGE_OVERFLOW')
  for (const [i, p] of pages.entries()) if (i) p.append(el('footer', String(i + 1), 'folio'))
  stats.logicalPages = pages.length; stats.nodes = pages.reduce((n, p) => n + p.querySelectorAll('*').length + 2, 0); assertBudget(stats)
  for (const p of pages) { const sheet = el('div', undefined, 'sheet'); sheet.append(p); output.append(sheet) }
  measure.replaceChildren(); check()
  const report = { complete: true, scope: '固定九篇DOM目录可行性；非生产快照/完整分页', case: kind, font: fallback ? 'system' : 'P5-WenKai', stats, tocPages: toc.length, trace: convergence.trace, titlePages: convergence.labels, titleAndBodyMatched: true, digitGeometryChecked: ['9', '10', '99', '100', '300'], limitations: ['三位页码为列宽几何测试，不是实际百页书性能测试', '不覆盖图片解码/手机峰值内存/任意富文本', '预算只校验计数，不证明来源计量器或真实DB安全'] }
  status.textContent = `目录就绪：${toc.length}页目录 / ${pages.length}逻辑页，${convergence.trace.length}轮收敛。仅隔离样张。`
  result.textContent = JSON.stringify(report, null, 2); document.documentElement.dataset.complete = 'true'; cancel.disabled = true
}
if (kind === 'cancel') setTimeout(() => controller.abort(), 0)
run().catch(error => {
  output.replaceChildren(); measure.replaceChildren(); cancel.disabled = true
  status.textContent = `停止：${error.code || error.message}`
  result.textContent = JSON.stringify({ complete: false, case: kind, code: error.code || error.message, cleared: true }, null, 2)
  document.documentElement.dataset.complete = 'false'
})
