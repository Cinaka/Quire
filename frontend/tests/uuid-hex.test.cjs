// Actual codec body; no Vite, Vue, IndexedDB or backend migration integration claim.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { stripTypeScriptTypes } = require('node:module')
const { test } = require('node:test')
const source = stripTypeScriptTypes(fs.readFileSync(path.join(__dirname, '../src/shared/uuidHex.ts'), 'utf8'))
let codec
async function load() {
  if (codec) return codec
  const module = new vm.SourceTextModule(source)
  await module.link(() => { throw Error('codec must have no external imports') })
  await module.evaluate()
  codec = module.namespace
  return codec
}
const old = '01a01dfa-6c0a-72a6-a7f5-76323ee01718'
const hex = '01a01dfa6c0a72a6a7f576323ee01718'

test('user example normalizes and roundtrips without changing identity', async () => {
  const mod = await load()
  assert.equal(mod.uuidToHex(old, true), hex)
  assert.equal(mod.uuidToLegacyText(hex), old)
})
test('uppercase inputs normalize to lowercase', async () => {
  const mod = await load()
  assert.equal(mod.uuidToHex(old.toUpperCase()), hex)
  assert.equal(mod.uuidToHex(hex.toUpperCase()), hex)
})
test('business UUID requires both v7 version and RFC variant', async () => {
  const mod = await load()
  for (const value of [hex.slice(0, 12) + '4' + hex.slice(13), hex.slice(0, 16) + 'f' + hex.slice(17)]) {
    assert.throws(() => mod.uuidToHex(value, true))
  }
})
test('does not silently accept whitespace, wrappers, URNs or invalid inputs', async () => {
  const mod = await load()
  for (const value of [null, undefined, [], 123, '', hex + '\n', old + '\n', hex + '\r\n', hex + '\u2028', ' ' + hex, `{${old}}`, `urn:uuid:${old}`, 'x'.repeat(32), hex.slice(1)]) {
    assert.throws(() => mod.uuidToHex(value), String(value))
  }
})
test('aliases must not collapse to silent data overwrites', async () => {
  const mod = await load()
  for (const values of [[hex, old], [hex, hex.toUpperCase()], [hex, hex]]) {
    assert.throws(() => mod.normalizeUuidList(values))
  }
})
test('list order and original array are preserved', async () => {
  const mod = await load()
  const other = '01a01e0ef90574aa894eff02c02fd01a'
  const before = [old, other]
  assert.deepEqual(Array.from(mod.normalizeUuidList(before, true)), [hex, other])
  assert.deepEqual(before, [old, other])
})
