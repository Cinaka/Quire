const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { loadTS } = require("./schedules-harness.cjs")
const source = fs.readFileSync(path.join(__dirname, "../src/db/schema.ts"), "utf8")

test("v1/v2 stores stay intact and v3 adds only schedules and a source index", () => {
  const stores = [...source.matchAll(/\.stores\(\{([\s\S]*?)\}\)/g)].map(match => match[1])
  assert.equal(stores.length, 3)
  for (const prior of stores.slice(0, 2)) {
    assert.doesNotMatch(prior, /schedules:|fromScheduleId/)
    for (const table of ["entries:", "tags:", "media:", "meta:"]) assert.ok(prior.includes(table))
  }
  assert.match(stores[2], /schedules: "id, remindDate, status, updatedAt, dirty, isDeleted, \[isDeleted\+status\+remindDate\]"/)
  assert.match(stores[2], /\*tagIds, fromScheduleId,/)
  assert.doesNotMatch(stores[2], /&fromScheduleId|deletedAt/)
  assert.doesNotMatch(source, /\.clear\(|\.delete\(|\.bulkDelete\(/)
})
test("P4 keys do not overlap P2 synchronization metadata", () => {
  const keys = Object.values(loadTS("shared/schedules.ts").SCHEDULE_META_KEYS)
  assert.equal(new Set(keys).size, 5)
  for (const key of keys) assert.ok(!["lastSyncAt", "conflicts", "syncErrors", "pendingPurges", "draft"].includes(key))
})
test("schedule and conversion writes remain hidden before real-storage acceptance", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/repo/index.ts"), "utf8")
  assert.doesNotMatch(source, /scheduleRepo|scheduleConversionRepo/)
})
