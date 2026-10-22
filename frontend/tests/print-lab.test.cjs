const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const { allowed } = require('../tools/print-lab/serve.cjs')
const root = path.resolve(__dirname, '..')
test('8-page booklet exact front/back mapping', async () => {
  const { impose } = await import('../tools/print-lab/imposition.mjs')
  assert.deepEqual(impose(8, 'booklet'), [[8, 1], [2, 7], [6, 3], [4, 5]])
})
for (const mode of ['a5', 'spread', 'booklet']) test(`${mode}: 1..300 pages appear once, blanks never masquerade as content`, async () => {
  const { impose } = await import('../tools/print-lab/imposition.mjs')
  for (let count = 1; count <= 300; count++) {
    const mapping = impose(count, mode), pages = mapping.flat(), filled = pages.filter(p => p !== null)
    assert.deepEqual([...filled].sort((a, b) => a - b), Array.from({ length: count }, (_, i) => i + 1))
    const expected = mode === 'booklet' ? Math.ceil(count / 4) * 4 : mode === 'spread' ? Math.ceil(count / 2) * 2 : count
    assert.equal(pages.length, expected)
    if (mode !== 'a5') assert(mapping.every(face => face.length === 2))
  }
})
for (const bad of [0, -1, 301, 1.5, NaN, Infinity, '8', null]) test(`rejects invalid count ${String(bad)}`, async () => {
  const { impose } = await import('../tools/print-lab/imposition.mjs'); assert.throws(() => impose(bad, 'booklet'))
})
test('reject unknown mode rather than silently choosing layout', async () => {
  const { impose } = await import('../tools/print-lab/imposition.mjs'); assert.throws(() => impose(8, 'other'))
})
test('static server only serves lab and P5 fonts, no app/API/private file route', () => {
  for (const file of ['/frontend/tools/print-lab/index.html', '/frontend/tools/print-lab/imposition.mjs', '/frontend/src/styles/notebook-fonts.css', '/frontend/src/assets/fonts/notebook/wenkai-004e.woff2']) assert(allowed(file))
  for (const file of ['/api/v1/auth/me', '/frontend/src/db/schema.ts', '/backend/.env', '/frontend/tools/print-lab/../../.env', '/frontend/src/assets/fonts/notebook/manifest.json']) assert(!allowed(file))
})
test('sample imports only fixed assets and has no private storage/network API calls', () => {
  const source = fs.readFileSync(path.join(root, 'tools/print-lab/lab.mjs'), 'utf8')
  assert(!/\b(?:fetch|XMLHttpRequest|indexedDB|localStorage|sessionStorage)\s*[.(]/.test(source))
  assert(!/from\s+['"](?:vue|dexie|@\/|\.\.\/)/.test(source))
  assert(source.includes("location.port !== '5184'"))
  assert(source.includes('joined !== block.text')); assert(source.includes('overflow.length'))
})
test('CSS has no clipping / screenshot stand-in for content or printable UI', () => {
  const css = fs.readFileSync(path.join(root, 'tools/print-lab/lab.css'), 'utf8')
  assert(!/overflow\s*:\s*hidden|text-overflow\s*:\s*ellipsis/.test(css))
  assert(css.includes('white-space: pre-wrap')); assert(css.includes('.lab-ui, #measure { display: none'))
})
