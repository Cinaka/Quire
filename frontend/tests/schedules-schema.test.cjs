const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { loadTS } = require("./schedules-harness.cjs")
const source = fs.readFileSync(path.join(__dirname, "../src/db/schema.ts"), "utf8")

test("v1/v2 stores stay intact and v3 adds only schedules and a source index", () => {
  const stores = [...source.matchAll(/\.stores\(\{([\s\S]*?)\}\)/g)].map(match => match[1])
  const versions = [...source.matchAll(/this\.version\((\d+)\)\s*\.stores\(/g)].map(match => Number(match[1]))
  assert.deepEqual(versions.slice(0, 3), [1, 2, 3])
  assert.ok(stores.length >= 3)
  const fields = text => Object.fromEntries([...text.matchAll(/(\w+):\s*"([^"]*)"/g)].map(match => [match[1], match[2]]))
  const entries = "id, entryDate, updatedAt, isDeleted, dirty, *tagIds, [isDeleted+entryDate], [isDeleted+updatedAt]"
  const prior = { entries, tags: "id, name, dirty", media: "id, entryId, createdAt, dirty", meta: "key" }
  assert.deepEqual(fields(stores[0]), prior)
  assert.deepEqual(fields(stores[1]), { ...prior, media: `${prior.media}, remoteUrl` })
  assert.deepEqual(fields(stores[2]), { ...prior,
    entries: entries.replace("*tagIds,", "*tagIds, fromScheduleId,"), media: `${prior.media}, remoteUrl`,
    schedules: "id, remindDate, status, updatedAt, dirty, isDeleted, [isDeleted+status+remindDate]",
  })
  for (const prior of stores.slice(0, 2)) {
    assert.doesNotMatch(prior, /schedules:|fromScheduleId/)
    for (const table of ["entries:", "tags:", "media:", "meta:"]) assert.ok(prior.includes(table))
  }
  assert.match(stores[2], /schedules: "id, remindDate, status, updatedAt, dirty, isDeleted, \[isDeleted\+status\+remindDate\]"/)
  assert.match(stores[2], /\*tagIds, fromScheduleId,/)
  assert.doesNotMatch(stores[2], /&fromScheduleId|deletedAt/)
  assert.doesNotMatch(source, /\.clear\(|\.delete\(|\.bulkDelete\(/)
})
test("v4 only adds the independent UUID32 format store and never resets during schema upgrade", () => {
  const versions = [...source.matchAll(/this\.version\((\d+)\)\s*\.stores\(\{([\s\S]*?)\}\)/g)]
  assert.deepEqual(versions.map(match => Number(match[1])), [1, 2, 3, 4])
  assert.match(versions[3][2], /^\s*localFormat:\s*"key",?\s*$/)
  const v4 = source.slice(source.indexOf("this.version(4)"))
  assert.doesNotMatch(v4, /\.upgrade\(|\.(?:clear|delete|bulkDelete|put|bulkPut|modify|add)\(/)
  assert.match(source, /localFormat!:\s*EntityTable<MetaRow, "key">/)
})
test("P4 keys do not overlap P2 synchronization metadata", () => {
  const keys = Object.values(loadTS("shared/schedules.ts").SCHEDULE_META_KEYS)
  assert.equal(new Set(keys).size, 5)
  for (const key of keys) assert.ok(!["lastSyncAt", "conflicts", "syncErrors", "pendingPurges", "draft"].includes(key))
})
test("schedule and conversion writes remain hidden before real-storage acceptance", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/repo/index.ts"), "utf8")
  assert.doesNotMatch(source, /scheduleRepo|scheduleConversionRepo|scheduleDraftRepo|scheduleEditorRepo/)
})
