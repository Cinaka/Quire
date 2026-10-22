const { test } = require('node:test')
const assert = require('node:assert/strict')
const { projectNotebookContent: project, notebookMediaId } = require('../src/shared/notebookContent.ts')
const id = '019b178b-1111-7111-8111-111111111111'
const text = value => ({ type: 'text', text: value })
const content = (...nodes) => ({ schemaVersion: 1, doc: { type: 'doc', content: nodes } })
const flatten = nodes => nodes.map(n => n.text ?? (n.children ? flatten(n.children) : '')).join('')
test('null and empty document are readable, not writes', () => {
  assert.deepEqual(project(null), { nodes: [], warnings: [], mediaIds: [] })
  assert.equal(project(content()).warnings.length, 0)
})
for (const type of ['paragraph', 'bulletList', 'orderedList', 'listItem', 'blockquote', 'codeBlock', 'hardBreak']) {
  test(`actual schema node ${type}`, () => { assert.equal(project(content({ type })).warnings.length, 0) })
}
for (const level of [1, 2, 3]) test(`heading level ${level}`, () => {
  const p = project(content({ type: 'heading', attrs: { level }, content: [text('春山')] }))
  assert.equal(p.nodes[0].children[0].tag, `h${level}`)
  assert.equal(p.warnings.length, 0)
})
for (const type of ['bold', 'italic', 'strike', 'code']) test(`mark ${type}`, () => {
  const p = project(content({ type: 'paragraph', content: [{ ...text('字'), marks: [{ type }] }] }))
  assert.equal(p.warnings.length, 0); assert.equal(flatten(p.nodes), '字')
})
for (const invalid of ['__proto__', 'constructor', 'toString', 'script', 'iframe', 'a']) test(`no prototype/raw DOM tag ${invalid}`, () => {
  const p = project(content({ type: invalid, content: [{ ...text('<script>alert(1)</script>'), marks: [{ type: invalid }] }] }))
  assert(p.warnings.length >= 1)
  assert(flatten(p.nodes).includes('<script>alert(1)</script>'))
  const tags = JSON.stringify(p.nodes)
  assert(!tags.includes(`"tag":"${invalid}"`))
})
test('ordered list start only bounded integer', () => {
  for (const start of [-1, 0, 1.5, '2', 1000001]) assert(project(content({ type: 'orderedList', attrs: { start } })).warnings.length)
  assert.equal(project(content({ type: 'orderedList', attrs: { start: 42 } })).nodes[0].children[0].start, 42)
})
test('unknown version preserves safe visible text with explicit diagnostic', () => {
  const p = project({ ...content({ type: 'newThing', text: '未丢失', content: [text('子文字')] }), schemaVersion: 99 })
  assert(p.warnings.some(s => s.includes('版本'))); assert(flatten(p.nodes).includes('未丢失子文字'))
})
test('malformed and cyclic nodes never masquerade as complete', () => {
  const cycle = { type: 'paragraph', content: [] }; cycle.content.push(cycle)
  for (const value of [{}, { schemaVersion: 1, doc: 3 }, content(null), content({ type: 'paragraph', content: {} }), content(cycle)]) assert(project(value).warnings.length)
})
test('long text, rare characters, emoji and whitespace are not truncated', () => {
  const body = '  𠮷🪶\n'.repeat(20000)
  const original = content({ type: 'paragraph', content: [text(body)] })
  const before = JSON.stringify(original), p = project(original)
  assert.equal(flatten(p.nodes), body); assert.equal(JSON.stringify(original), before)
})
test('only exact local UUIDv7 references; no normalization into new IDs', () => {
  assert.equal(notebookMediaId(`local://media/${id}`), id)
  for (const src of [`https://evil.test/${id}`, `//evil.test/${id}`, `data:image/svg+xml,hi`, `blob:${id}`, `local://media/${id}?x`, `local://media/${id}/`, `local://media/not-uuid`]) {
    assert.equal(notebookMediaId(src), null)
    const p = project(content({ type: 'image', attrs: { src, alt: '<img onerror=x>' } }))
    assert.deepEqual(p.mediaIds, []); assert(p.warnings.length)
  }
})
test('valid images deduplicate references, preserve alt as text, never spread attrs', () => {
  const node = { type: 'image', attrs: { src: `local://media/${id}`, alt: '<test>', title: '题', onerror: 'bad()', style: 'bad' } }
  const p = project(content(node, node))
  assert.deepEqual(p.mediaIds, [id]); assert(!JSON.stringify(p.nodes).includes('bad'))
})
test('invalid heading and marks are diagnosed, original text retained', () => {
  const p = project(content({ type: 'heading', attrs: { level: 7 }, content: [{ ...text('仍可读'), marks: 'not-array' }] }))
  assert(p.warnings.length >= 2); assert.equal(flatten(p.nodes), '仍可读')
})
test('extreme nesting is explicit partial reading, not a stack overflow', () => {
  let n = text('deep'); for(let i=0;i<160;i++) n={type:'blockquote',content:[n]}
  assert(project(content(n)).warnings.some(s=>s.includes('安全阅读上限')))
})
