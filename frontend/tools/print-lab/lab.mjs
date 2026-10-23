import { impose } from './imposition.mjs'
import { entries, sourceText } from './fixtures.mjs'
import { calibrationImage } from './image.mjs'

// Proof of concept only. Does NOT handle arbitrary P5 projection/marks/nested lists.
const params = new URLSearchParams(location.search)
const mode = params.get('mode') || 'a5', numbered = params.get('numbered') === '1'
const fallback = params.get('font') === 'fallback'
const output = document.querySelector('#output'), measure = document.querySelector('#measure')
const status = document.querySelector('#status'), result = document.querySelector('#result')
const node = (tag, text, className) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e }
const graphemes = text => Array.from(new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(text), s => s.segment)
const report = value => { result.textContent = JSON.stringify(value, null, 2); document.documentElement.dataset.complete = value.complete ? 'true' : 'false' }
let logical = [], pages = [], current
function page(kind = '') {
  const paper = node('section', undefined, `paper ${kind}`), body = node('div', undefined, 'body')
  paper.append(body); measure.append(paper); logical.push(paper)
  if (logical.length > 50) throw Error('隔离样张超过50页，停止原型')
  return { paper, body }
}
function fits(body) {
  const last = body.lastElementChild
  return !last || (last.getBoundingClientRect().bottom <= body.getBoundingClientRect().bottom - .5 && body.scrollWidth <= body.clientWidth + 1)
}
function nextBody() { current = page(); pages.push(current); return current }
function textBlock(block, text, key) {
  const tag = block.type === 'code' ? 'pre' : block.type === 'quote' ? 'blockquote' : 'p'
  const e = node(tag, undefined, block.type === 'li' ? 'list-item' : '')
  if (block.type === 'li') e.append(node('span', `${block.number}.`, 'marker'))
  const fragment = node('span', text); fragment.dataset.source = key; e.append(fragment)
  return e
}
function appendText(block, key) {
  const characters = graphemes(block.text)
  let cursor = 0
  while (cursor < characters.length) {
    let e = textBlock(block, '', key); current.body.append(e)
    const span = e.querySelector('[data-source]')
    let low = 0, high = characters.length - cursor
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      span.textContent = characters.slice(cursor, cursor + mid).join('')
      if (fits(current.body)) low = mid; else high = mid - 1
    }
    if (!low) {
      e.remove()
      if (!current.body.children.length) throw Error('单个字形也无法放入纸页，停止原型')
      nextBody(); continue
    }
    span.textContent = characters.slice(cursor, cursor + low).join(''); cursor += low
    if (cursor < characters.length) nextBody()
  }
}
async function appendImage(block) {
  const figure = node('figure'), image = node('img'), caption = node('figcaption', block.caption)
  image.alt = block.alt; image.src = calibrationImage; figure.append(image, caption)
  current.body.append(figure); await image.decode()
  if (!fits(current.body)) { figure.remove(); nextBody().body.append(figure) }
  if (!fits(current.body)) throw Error('固定整图未能安全放入纸页')
}
async function run() {
  if (location.protocol !== 'http:' || location.hostname !== '127.0.0.1' || location.port !== '5184') throw Error('仅允许127.0.0.1:5184隔离样张，不导入业务')
  if (!['a5', 'spread', 'booklet'].includes(mode)) throw Error('未知输出模式')
  document.documentElement.classList.toggle('fallback', fallback)
  const fontText = sourceText() + entries.map(e => e.title).join('') + '青简杀青目录固定样张'
  if (!fallback) {
    let timer
    try {
      await Promise.race([
        document.fonts.load('16px "Quire Notebook WenKai"', fontText),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('字体等待超时；可明确选择系统回退样张')), 12000) }),
      ])
    } finally { clearTimeout(timer) }
    await document.fonts.ready
    if ([...document.fonts].some(f => f.status === 'error')) throw Error('字体加载失败，未自动降级或打印')
  }
  if (numbered) {
    for (let i = 1; i <= 8; i++) {
      const p = page('numbered'); p.body.append(node('span', '↑ TOP', 'up'), node('strong', String(i)), node('span', '上方箭头 / 左侧装订 / 非私人样张', 'label'))
    }
  } else {
    const cover = page('cover')
    cover.body.append(node('p', 'QUIRE / PRINT LAB', 'brand'), node('div', undefined, 'rule'), node('h2', '杀青'), node('p', '一编青简，半生浮沉。'), node('p', '固定非私人材料 · P6-0'), node('p', '2026.10.21 — 2026.10.23'))
    const toc = page(); toc.body.append(node('p', 'CONTENTS', 'date'), node('h2', '目录'))
    for (const entry of entries) {
      nextBody(); const first = current.paper
      current.body.append(node('p', entry.date, 'date'), node('h2', entry.title))
      for (const [index, block] of entry.blocks.entries()) {
        if (block.type === 'image') await appendImage(block)
        else appendText(block, `${entry.id}:${index}`)
      }
      const row = node('p', undefined, 'toc-row')
      row.append(node('span', `${entry.date}  ${entry.title}`), node('span', String(logical.indexOf(first) + 1))); toc.body.append(row)
    }
    if (!fits(toc.body)) throw Error('固定三篇目录不适合单页；此原型未实现多页目录')
    for (const entry of entries) for (const [i, block] of entry.blocks.entries()) {
      if (block.type === 'image') continue
      const joined = logical.flatMap(p => [...p.querySelectorAll('[data-source]')]).filter(e => e.dataset.source === `${entry.id}:${i}`).map(e => e.textContent).join('')
      if (joined !== block.text) throw Error(`源字符不守恒：${entry.id}:${i}`)
    }
  }
  logical.forEach((p, i) => { if (i || numbered) p.append(node('footer', String(i + 1), 'folio')) })
  const overflow = logical.flatMap((p, i) => fits(p.querySelector('.body')) ? [] : [i + 1])
  if (overflow.length) throw Error(`页盒溢出：${overflow.join(',')}`)
  const mapping = impose(logical.length, mode)
  if (mode !== 'a5') {
    const style = node('style'); style.textContent = '@page { size: A4 landscape; margin: 0; }'; document.head.append(style)
  }
  for (const pair of mapping) {
    const sheet = node('div', undefined, mode === 'a5' ? 'sheet' : 'sheet wide')
    for (const n of pair) sheet.append(n === null ? node('section', undefined, 'paper blank') : logical[n - 1].cloneNode(true))
    output.append(sheet)
  }
  await Promise.all([...output.querySelectorAll('img')].map(i => i.decode()))
  measure.replaceChildren()
  const reportValue = { scope: '固定非私人DOM分页原型；无Vue/身份/IndexedDB/正式入口', complete: true, mode, numbered, font: fallback ? 'explicit-system-fallback' : 'P5-WenKai', logicalPages: logical.length, physicalFaces: mapping.length, mapping, overflow, sourceCharacters: numbered ? 0 : sourceText().length, textConserved: !numbered, loadedFontFaces: [...document.fonts].filter(f => f.status === 'loaded').length, limitations: ['仅固定段落/引用/简单列表/代码/图片，未实现任意富文本', '目录仅三项单页，尚无多页目录收敛', '不是系统打印对话框或实物折叠验收', '未测Safari/Firefox/手机与大规模预算'] }
  status.textContent = `样张就绪：${logical.length} 逻辑页 / ${mapping.length} 纸面。仅隔离原型，不代表P6功能验收。`
  report(reportValue)
}
run().catch(error => { output.replaceChildren(); measure.replaceChildren(); status.textContent = `停止：${error.message}`; report({ complete: false, error: error.message }) })
