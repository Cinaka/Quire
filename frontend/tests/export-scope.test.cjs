const { test } = require('node:test')
const assert = require('node:assert/strict')
const { validExportDate, compileExportSelection, matchesExportSelection, compareExportEntries, createExportSelectionAccumulator } = require('../src/shared/exportScope.ts')
const row = (overrides = {}) => ({ id: 'entry', entryDate: '2026-10-21', sortOrder: 0, title: '雨后 Reading', contentText: '一编青简，半生浮沉。 hello 🌿', tagIds: ['daily', 'book'], hasImage: true, isDeleted: 0, deletedAt: null, ...overrides })
const compile = (scope = { kind: 'all' }, filters) => compileExportSelection({ scope, ...(filters === undefined ? {} : { filters }) })
const code = (work, value) => assert.throws(work, { code: value })
for (const [scope, from, to] of [
  [{ kind: 'day', date: '2026-10-21' }, '2026-10-21', '2026-10-21'],
  [{ kind: 'month', month: '2026-02' }, '2026-02-01', '2026-02-28'],
  [{ kind: 'month', month: '2024-02' }, '2024-02-01', '2024-02-29'],
  [{ kind: 'month', month: '2000-02' }, '2000-02-01', '2000-02-29'],
  [{ kind: 'month', month: '1900-02' }, '1900-02-01', '1900-02-28'],
  [{ kind: 'month', month: '2026-04' }, '2026-04-01', '2026-04-30'],
  [{ kind: 'month', month: '2026-12' }, '2026-12-01', '2026-12-31'],
  [{ kind: 'year', year: '0001' }, '0001-01-01', '0001-12-31'],
  [{ kind: 'year', year: '9999' }, '9999-01-01', '9999-12-31'],
  [{ kind: 'range', from: '2025-12-31', to: '2026-01-01' }, '2025-12-31', '2026-01-01'],
]) test(`calendar boundaries ${JSON.stringify(scope)}`, () => {
  const p = compile(scope); assert.equal(p.from, from); assert.equal(p.to, to); assert(!p.emptyIntersection)
  assert(matchesExportSelection(p, row({ entryDate: from }))); assert(matchesExportSelection(p, row({ entryDate: to })))
})
test('strict natural dates never parse timezone or normalize invalid dates', () => {
  for (const d of ['2026-02-29', '2026-04-31', '0000-01-01', '2026-00-01', '2026-13-01', '2026-10-00', '2026-10-32', '2026-1-01', '2026-10-21T00:00:00Z', ' 2026-10-21', '２０２６-10-21', '', null, undefined, 20261021]) assert(!validExportDate(d), String(d))
  for (const d of ['0001-01-01', '9999-12-31', '2024-02-29', '2000-02-29']) assert(validExportDate(d))
})
for (const scope of [null, {}, { kind: 'unknown' }, { kind: 'entry', id: '' }, { kind: 'entry', id: 'bad\n' }, { kind: 'entry', id: 'a'.repeat(129) }, { kind: 'day', date: '2026-02-29' }, { kind: 'month', month: '2026-13' }, { kind: 'month', month: '2026-2' }, { kind: 'year', year: '0000' }, { kind: 'year', year: 2026 }, { kind: 'range', from: '2026-10-22', to: '2026-10-21' }, { kind: 'all', page: 2 }]) test(`invalid scope rejected ${JSON.stringify(scope)}`, () => assert.throws(() => compile(scope)))
test('single entry still intersects explicit dates, tags and keyword', () => {
  const p = compile({ kind: 'entry', id: 'entry' }, { dateFrom: '2026-10-21', dateTo: '2026-10-21', tagIds: ['daily'], keyword: 'reading', hasImage: true })
  assert(matchesExportSelection(p, row())); assert(!matchesExportSelection(p, row({ id: 'other' }))); assert(!matchesExportSelection(p, row({ entryDate: '2026-10-20' }))); assert(!matchesExportSelection(p, row({ tagIds: [] })))
})
test('month and carried list range form an inclusive intersection', () => {
  const p = compile({ kind: 'month', month: '2026-10' }, { dateFrom: '2026-10-10', dateTo: '2026-11-05' })
  assert.equal(p.from, '2026-10-10'); assert.equal(p.to, '2026-10-31')
  for (const d of ['2026-10-10', '2026-10-31']) assert(matchesExportSelection(p, row({ entryDate: d })))
  for (const d of ['2026-10-09', '2026-11-01']) assert(!matchesExportSelection(p, row({ entryDate: d })))
})
test('disjoint valid dates are explicit empty intersection, not widened scope', () => {
  const p = compile({ kind: 'day', date: '2026-10-21' }, { dateFrom: '2026-10-22' }); assert(p.emptyIntersection)
  assert(!matchesExportSelection(p, row())); assert.deepEqual(createExportSelectionAccumulator(p).finish(), [])
})
test('all has no inherited invisible list conditions', () => {
  const p = compile(); assert.equal(p.from, null); assert.equal(p.to, null); assert.deepEqual(p.filters, {})
  assert(matchesExportSelection(p, row({ hasImage: false, tagIds: [], title: '', contentText: '' })))
})
for (const override of [{ isDeleted: 1 }, { deletedAt: '2026-10-21' }, { isDeleted: 1, deletedAt: '2026-10-21' }]) test(`both active flags required ${JSON.stringify(override)}`, () => assert(!matchesExportSelection(compile(), row(override))))
test('all tags required and input duplicates do not change meaning', () => {
  const p = compile(undefined, { tagIds: ['daily', 'daily', 'book'] }); assert.deepEqual(p.filters.tagIds, ['daily', 'book'])
  assert(matchesExportSelection(p, row())); assert(!matchesExportSelection(p, row({ tagIds: ['daily'] })))
})
test('false image condition remains explicit and empty keyword is unrestricted', () => {
  const p = compile(undefined, { hasImage: false, keyword: '' }); assert(!matchesExportSelection(p, row())); assert(matchesExportSelection(p, row({ hasImage: false })))
})
test('keyword uses stored title/body plain text, case-insensitive substring, no regex', () => {
  for (const keyword of ['READING', 'HELLO', '半生', '🌿']) assert(matchesExportSelection(compile(undefined, { keyword }), row()))
  for (const keyword of ['.*', ' hello ', 'missing']) assert(!matchesExportSelection(compile(undefined, { keyword }), row({ contentText: 'hello' })))
})
test('empty book and empty title/body are valid selections', () => {
  assert(matchesExportSelection(compile(), row({ title: '', contentText: '', tagIds: [] })))
  assert.deepEqual(createExportSelectionAccumulator(compile()).finish(), [])
})
test('request is copied/frozen before asynchronous adapter use', () => {
  const request = { scope: { kind: 'month', month: '2026-10' }, filters: { tagIds: ['daily'], keyword: 'hello' } }, p = compileExportSelection(request)
  request.scope.month = '2026-11'; request.filters.tagIds.push('other'); request.filters.keyword = 'missing'
  assert.equal(p.scope.month, '2026-10'); assert.deepEqual(p.filters.tagIds, ['daily']); assert.equal(p.filters.keyword, 'hello')
  assert(Object.isFrozen(p)); assert(Object.isFrozen(p.scope)); assert(Object.isFrozen(p.filters)); assert(Object.isFrozen(p.filters.tagIds))
})
for (const filters of [null, [], { dateFrom: '2026-02-29' }, { dateFrom: '2026-10-22', dateTo: '2026-10-21' }, { hasImage: 0 }, { hasImage: 'false' }, { keyword: 1 }, { keyword: 'x'.repeat(4097) }, { tagIds: [''] }, { tagIds: Array(101).fill('tag') }, { page: 2 }, { pageSize: 20 }, { order: 'updatedAtDesc' }, { onlyDeleted: true }]) test(`invalid or pagination filter rejected ${JSON.stringify(filters).slice(0, 70)}`, () => assert.throws(() => compile(undefined, filters)))
test('export sort is date ascending, same-day sortOrder descending, binary ID ascending', () => {
  const rows = [row({ id: 'z', entryDate: '2026-10-20', sortOrder: -1 }), row({ id: 'b', sortOrder: 2 }), row({ id: 'a', sortOrder: 2 }), row({ id: 'c', sortOrder: 3 }), row({ id: 'd', entryDate: '2026-10-22', sortOrder: 999 })]
  assert.deepEqual(rows.sort(compareExportEntries).map(r => r.id), ['z', 'c', 'a', 'b', 'd'])
  assert(compareExportEntries(row({ id: 'Z' }), row({ id: 'a' })) < 0)
})
test('more than 20 selected entries are retained independent of feed order', () => {
  const acc = createExportSelectionAccumulator(compile())
  for (let n = 37; n > 0; n--) acc.add(row({ id: String(n).padStart(3, '0') }))
  assert.deepEqual(acc.finish().map(r => r.id), Array.from({ length: 37 }, (_, i) => String(i + 1).padStart(3, '0')))
})
test('100 selected accepted; source mutation cannot change retained membership/order', () => {
  const acc = createExportSelectionAccumulator(compile()), first = row({ id: '000' }); acc.add(first); first.id = 'changed'; first.entryDate = '2020-01-01'
  for (let n = 1; n < 100; n++) acc.add(row({ id: String(n).padStart(3, '0') }))
  const result = acc.finish(); assert.equal(result.length, 100); assert.equal(result[0].id, '000'); assert.equal(result[0].entryDate, '2026-10-21'); assert(Object.isFrozen(result)); assert(result.every(Object.isFrozen))
  assert.deepEqual(Object.keys(result[0]).sort(), ['entryDate', 'id', 'sortOrder'])
})
test('101st selected rejects whole accumulator, cannot publish partial 100', () => {
  const acc = createExportSelectionAccumulator(compile())
  for (let n = 0; n < 100; n++) acc.add(row({ id: String(n) }))
  code(() => acc.add(row({ id: '101' })), 'EXPORT_ENTRY_LIMIT'); code(() => acc.finish(), 'EXPORT_SELECTION_CLOSED')
})
test('filtered-out entries do not consume selected budget', () => {
  const acc = createExportSelectionAccumulator(compile(undefined, { hasImage: true }))
  for (let n = 0; n < 101; n++) assert(!acc.add(row({ id: String(n), hasImage: false })))
  assert(acc.add(row())); assert.equal(acc.finish().length, 1)
})
test('duplicate selected ID fails instead of emitting same diary twice', () => {
  const acc = createExportSelectionAccumulator(compile()); acc.add(row()); code(() => acc.add(row()), 'DUPLICATE_EXPORT_ENTRY'); code(() => acc.finish(), 'EXPORT_SELECTION_CLOSED')
})
test('cancel discards membership, no finish or later resurrection', () => {
  const acc = createExportSelectionAccumulator(compile()); acc.add(row()); acc.cancel(); acc.cancel()
  code(() => acc.finish(), 'EXPORT_SELECTION_CLOSED'); code(() => acc.add(row()), 'EXPORT_SELECTION_CLOSED')
})
test('finished accumulator cannot be reused for a second selection', () => {
  const acc = createExportSelectionAccumulator(compile()); acc.finish(); acc.cancel(); code(() => acc.add(row()), 'EXPORT_SELECTION_CLOSED'); code(() => acc.finish(), 'EXPORT_SELECTION_CLOSED')
})
test('forged plan cannot bypass normalized criteria; this is not auth verification', () => {
  const p = compile(), forged = { ...p }; code(() => matchesExportSelection(forged, row()), 'UNCOMPILED_EXPORT_SELECTION'); code(() => createExportSelectionAccumulator(forged), 'UNCOMPILED_EXPORT_SELECTION')
})
for (const override of [{ id: '' }, { entryDate: '2026-02-30' }, { sortOrder: NaN }, { sortOrder: Infinity }, { sortOrder: 0.5 }, { title: undefined }, { contentText: null }, { tagIds: [''] }, { hasImage: undefined }, { isDeleted: true }, { deletedAt: undefined }]) test(`malformed candidate fails closed ${JSON.stringify(override)}`, () => {
  const acc = createExportSelectionAccumulator(compile()); code(() => acc.add(row(override)), 'INVALID_EXPORT_CANDIDATE'); code(() => acc.finish(), 'EXPORT_SELECTION_CLOSED')
})
test('pure module introduces no browser, DB, network or ordinary list import', () => {
  const fs = require('node:fs'), s = fs.readFileSync(require.resolve('../src/shared/exportScope.ts'), 'utf8')
  assert(!/^import\s/m.test(s)); assert(!/\b(?:window|document|indexedDB|localStorage|fetch|Date|Intl)\s*[.(]/.test(s))
  assert(!s.includes('localeCompare(')); assert(!s.includes('entryRepo'))
})
test('membership ignores dirty and conversion provenance without reading draft/source evidence', () => {
  const acc = createExportSelectionAccumulator(compile())
  assert(acc.add(row({ id: 'dirty', dirty: 1 })))
  assert(acc.add(row({ id: 'converted', dirty: 0, fromScheduleId: 'source' })))
  assert.deepEqual(acc.finish().map(r => r.id), ['converted', 'dirty'])
})
test('criterion input guard boundaries remain explicit', () => {
  const p = compile(undefined, { keyword: 'x'.repeat(4096), tagIds: Array.from({ length: 100 }, (_, i) => `tag-${i}`) })
  assert.equal(p.filters.keyword.length, 4096); assert.equal(p.filters.tagIds.length, 100)
})
test('same natural-day selection is timezone independent in actual Node processes', () => {
  const { execFileSync } = require('node:child_process'), path = require.resolve('../src/shared/exportScope.ts')
  const program = `const m = require(${JSON.stringify(path)}); console.log(JSON.stringify(m.compileExportSelection({scope:{kind:'month',month:'2024-02'}})))`
  const values = ['UTC', 'America/Los_Angeles', 'Asia/Shanghai'].map(TZ => execFileSync(process.execPath, ['-e', program], { env: { ...process.env, TZ }, encoding: 'utf8' }))
  assert.equal(values[0], values[1]); assert.equal(values[1], values[2])
})
