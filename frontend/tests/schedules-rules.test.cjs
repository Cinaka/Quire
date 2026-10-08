const { test } = require("node:test")
const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const { loadTS } = require("./schedules-harness.cjs")
const rules = loadTS("shared/schedules.ts")
const today = "2026-10-08"
const id = "019a0300-1234-7000-8000-000000000001"
const content = text => ({ schemaVersion: 1, doc: {
  type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }],
} })
const row = extra => ({ remindDate: today, status: "pending", isDeleted: 0,
  convertedEntryId: null, convertedAt: null, ...extra })

test("new dates accept future only; rescheduling accepts an elapsed natural day", () => {
  rules.assertNewScheduleDate("2026-10-09", today)
  assert.throws(() => rules.assertNewScheduleDate(today, today), /未来/)
  assert.throws(() => rules.assertNewScheduleDate("2026-10-07", today), /未来/)
  rules.assertScheduleDate("2026-10-07")
})
test("invalid dates and invalid reference days are rejected", () => {
  for (const value of ["2026-02-29", "2026-13-01", "2026-10-00", "2026-1-1", "bad"]) {
    assert.throws(() => rules.assertScheduleDate(value))
  }
  assert.throws(() => rules.assertNewScheduleDate("2026-10-09", "bad"))
})
test("leap days, month-end and year-end remain natural dates", () => {
  rules.assertScheduleDate("2028-02-29")
  assert.equal(rules.schedulePhase(row({ remindDate: "2027-01-01" }), "2026-12-31"), "future")
  assert.equal(rules.schedulePhase(row({ remindDate: "2026-12-31" }), "2027-01-01"), "overdue")
})
test("due and overdue are derived without modifying the row", () => {
  const source = row({ remindDate: "2026-10-09", dirty: 0, clientUpdatedAt: "original" })
  const before = JSON.stringify(source)
  assert.equal(rules.schedulePhase(source, today), "future")
  assert.equal(rules.schedulePhase(source, "2026-10-09"), "due")
  assert.equal(rules.schedulePhase(source, "2026-10-10"), "overdue")
  assert.equal(JSON.stringify(source), before)
})
test("deletion and terminal conversion take precedence over date", () => {
  assert.equal(rules.schedulePhase(row({ status: "converted" }), today), "converted")
  assert.equal(rules.schedulePhase(row({ status: "converted", isDeleted: 1 }), today), "deleted")
  assert.throws(() => rules.schedulePhase(row({ status: "bogus" }), today))
})
test("title or text is sufficient; whitespace-only bodies are rejected", () => {
  rules.assertScheduleBody("标题", null)
  rules.assertScheduleBody("", content("正文"))
  assert.throws(() => rules.assertScheduleBody(" ", content("\n  ")), /填写/)
})
test("StarterKit text formatting and lists are retained", () => {
  const body = content("原文")
  body.doc.content[0].content[0].marks = [{ type: "bold" }]
  body.doc.content.push({ type: "bulletList", content: [{ type: "listItem", content: [
    { type: "paragraph", content: [{ type: "text", text: "列表" }] },
  ] }] })
  rules.assertScheduleContent(body)
})
test("nested image nodes, arbitrary marks and unsupported versions are rejected", () => {
  const image = content("文字")
  image.doc.content[0].content.push({ type: "image", attrs: { src: "https://example.com/a.png" } })
  assert.throws(() => rules.assertScheduleContent(image), /仅支持文本/)
  const link = content("文字")
  link.doc.content[0].content[0].marks = [{ type: "link", attrs: { href: "x" } }]
  assert.throws(() => rules.assertScheduleContent(link), /标记/)
  assert.throws(() => rules.assertScheduleContent({ ...content("x"), schemaVersion: 2 }), /版本/)
})
test("malformed, cyclic and too-deep trees fail before storage", () => {
  assert.throws(() => rules.assertScheduleContent({ schemaVersion: 1, doc: { type: "doc", content: {} } }))
  const body = content("x")
  body.doc.content.push(body.doc)
  assert.throws(() => rules.assertScheduleContent(body))
  let node = { type: "text", text: "x" }
  for (let i = 0; i < 102; i++) node = { type: "blockquote", content: [node] }
  assert.throws(() => rules.assertScheduleContent({ schemaVersion: 1, doc: { type: "doc", content: [node] } }))
})
test("conversion IDs remain the same UUID v7 and reject random namespaces", () => {
  assert.equal(rules.scheduleEntryId(id), id)
  assert.equal(rules.scheduleEntryId(id.toUpperCase()), id)
  assert.throws(() => rules.scheduleEntryId(id.replace("-7000-", "-4000-")), /UUID v7/)
})
test("conversion rejects future, deleted, already-converted and inconsistent sources", () => {
  rules.assertConvertibleSchedule(row(), today)
  rules.assertConvertibleSchedule(row({ remindDate: "2026-10-07" }), today)
  for (const extra of [{ remindDate: "2026-10-09" }, { isDeleted: 1 },
    { status: "converted" }, { convertedEntryId: id }]) {
    assert.throws(() => rules.assertConvertibleSchedule(row(extra), today))
  }
})
test("same-millisecond and clock-backwards edits get distinct UTC revisions", () => {
  const at = "2026-10-08T10:00:00.000Z"
  assert.equal(rules.nextScheduleRevision(at, at), "2026-10-08T10:00:00.001Z")
  assert.equal(rules.nextScheduleRevision(at, "2026-10-07T10:00:00.000Z"), "2026-10-08T10:00:00.001Z")
  assert.throws(() => rules.nextScheduleRevision("bad", at))
})
test("Shanghai and New York derive local dates rather than slicing UTC", () => {
  const harness = JSON.stringify(require.resolve("./schedules-harness.cjs"))
  const code = `const {loadTS}=require(${harness}); console.log(loadTS('shared/time.ts').todayLocal(new Date('2026-10-08T00:30:00Z')))`
  for (const [tz, expected] of [["Asia/Shanghai", "2026-10-08"], ["America/New_York", "2026-10-07"]]) {
    const out = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", env: { ...process.env, TZ: tz } })
    assert.equal(out.status, 0, out.stderr)
    assert.equal(out.stdout.trim(), expected)
  }
})
