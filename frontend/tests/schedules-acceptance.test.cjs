const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { loadTS } = require("./schedules-harness.cjs")
const { setup, entry, content, ID, AT } = require("./schedules-data-harness.cjs")
const guard = loadTS("acceptance/guard.ts", {}, { URL })
const spec = { enabled: true, dailyOrigin: "http://localhost:5173", testOrigin: "http://127.0.0.1:5179" }
const location = () => ({ origin: spec.testOrigin, pathname: "/p4-acceptance.html" })
const snapshot = h => JSON.stringify(Object.fromEntries(Object.entries(h.stores).map(([k, v]) => [k, [...v.rows.values()]])))
function harness() {
  let token = ""; let generation = 0
  const window = { location: location() }
  const h = setup({ "@/api/tokenStore": { getAccessToken: () => token, tokenGeneration: () => generation } }, { URL, window })
  h.db.name = guard.ACCEPTANCE_DB_NAME
  return { ...h, window, fixtures: h.load("acceptance/fixtures.ts"), switch(value) { token = value; generation++ } }
}

test("acceptance requires dedicated opt-in, exact page, loopback origin and a different canonical daily origin", () => {
  assert.deepEqual(structuredClone(guard.assertAcceptanceLocation(spec, location())), spec)
  for (const bad of [{ ...spec, enabled: false }, { ...spec, dailyOrigin: spec.testOrigin }, { ...spec, testOrigin: "https://quire.example" },
    { ...spec, dailyOrigin: "http://user:pass@localhost:5173" }, { ...spec, dailyOrigin: "http://localhost:5173/path" }, { ...spec, testOrigin: "http://127.0.0.1:5179?x=1" }]) assert.throws(() => guard.assertAcceptanceLocation(bad, location()))
  for (const address of [{ ...location(), origin: spec.dailyOrigin }, { ...location(), pathname: "/" }, { ...location(), pathname: "/entry" }]) assert.throws(() => guard.assertAcceptanceLocation(spec, address))
})
test("marker is strict and order-independent, refusing unknown or malformed values without serializing cycles", () => {
  assert.equal(guard.isAcceptanceMarker({ testOrigin: spec.testOrigin, dailyOrigin: spec.dailyOrigin, kind: "quire-p4-acceptance/v1" }, spec), true)
  const cyclic = {}; cyclic.self = cyclic
  for (const value of [null, cyclic, [], { ...guard.acceptanceMarker(spec), extra: true }, { ...guard.acceptanceMarker(spec), testOrigin: spec.dailyOrigin }]) assert.equal(guard.isAcceptanceMarker(value, spec), false)
})
test("initialization creates only an acceptance marker, never a business fixture or account claim", async () => {
  const h = harness(); await h.fixtures.initializeAcceptance(spec)
  for (const name of ["entries", "tags", "media", "schedules"]) assert.equal(h.stores[name].rows.size, 0)
  assert.deepEqual((await h.db.meta.get(guard.ACCEPTANCE_MARKER)).value, structuredClone(guard.acceptanceMarker(spec)))
  const before = snapshot(h); await h.fixtures.initializeAcceptance(spec); assert.equal(snapshot(h), before)
})
test("default quire database, wrong origin or existing token refuses before any tables are touched", async () => {
  for (const mutate of [h => { h.db.name = "quire" }, h => { h.window.location.origin = spec.dailyOrigin }, h => h.switch("real-token")]) {
    const h = harness(); mutate(h); const before = snapshot(h); await assert.rejects(h.fixtures.initializeAcceptance(spec)); assert.equal(snapshot(h), before)
  }
})
test("unknown existing data/metadata is never adopted or cleared by initial marker creation", async () => {
  for (const write of [h => h.db.entries.put(entry()), h => h.db.meta.put({ key: "draft", value: { private: true } }), h => h.db.meta.put({ key: guard.ACCEPTANCE_MARKER, value: { unknown: true } })]) {
    const h = harness(); await write(h); const before = snapshot(h); await assert.rejects(h.fixtures.initializeAcceptance(spec)); assert.equal(snapshot(h), before)
  }
})
test("explicit fixture creates three natural-date pending schedules and an unlinked first-save draft atomically", async () => {
  const h = harness(); await h.fixtures.initializeAcceptance(spec); await h.fixtures.seedAcceptance(spec)
  const schedules = await h.db.schedules.toArray(); assert.equal(schedules.length, 3); assert.equal(new Set(schedules.map(x => x.id)).size, 3)
  assert.ok(schedules.every(x => x.status === "pending" && x.dirty === 1 && x.convertedEntryId === null))
  assert.equal(h.stores.entries.rows.size, 0); const draft = (await h.db.meta.get("draft")).value
  assert.equal(draft.entryId, null); assert.equal(draft.mood, null); assert.equal(draft.doc.type, "doc")
  const dates = schedules.map(x => x.remindDate).sort(); assert.ok(dates[0] < draft.entryDate); assert.equal(dates[1], draft.entryDate); assert.ok(dates[2] > draft.entryDate)
})
test("seed requires a marker and empty business/draft metadata, repeated clicks never add copies", async () => {
  const h = harness(); await assert.rejects(h.fixtures.seedAcceptance(spec)); await h.fixtures.initializeAcceptance(spec); await h.fixtures.seedAcceptance(spec)
  const before = snapshot(h); await assert.rejects(h.fixtures.seedAcceptance(spec)); assert.equal(snapshot(h), before)
})
test("concurrent fixture requests commit at most one set, without clearing a winner", async () => {
  const h = harness(); await h.fixtures.initializeAcceptance(spec)
  const outcomes = await Promise.allSettled([h.fixtures.seedAcceptance(spec), h.fixtures.seedAcceptance(spec)])
  assert.equal(outcomes.filter(x => x.status === "fulfilled").length, 1); assert.equal(h.stores.schedules.rows.size, 3)
})
test("schedule/meta write failures roll back every fixture row and preserve the original marker", async () => {
  for (const table of ["schedules", "meta"]) {
    const h = harness(); await h.fixtures.initializeAcceptance(spec); const before = snapshot(h); h.failNext(table)
    await assert.rejects(h.fixtures.seedAcceptance(spec), /injected storage failure/); assert.equal(snapshot(h), before)
  }
})
test("identity changes during fixture writes roll back rather than binding data or clearing credentials", async () => {
  const h = harness(); await h.fixtures.initializeAcceptance(spec); const put = h.db.schedules.add; const before = snapshot(h)
  h.db.schedules.add = async row => { await put(row); h.switch("other-account") }
  await assert.rejects(h.fixtures.seedAcceptance(spec), /游客/); assert.equal(snapshot(h), before)
})
function nativeDb({ exists = true, version = 30, marker = guard.acceptanceMarker(spec), upgrade = false, blocked = false } = {}) {
  const calls = []; let closed = 0; let aborted = 0
  const factory = { async databases() { calls.push("list"); return exists ? [{ name: guard.ACCEPTANCE_DB_NAME }] : [] }, open(name, requestedVersion) {
    calls.push([name, requestedVersion]); const request = { transaction: { abort() { aborted++ } } }
    queueMicrotask(() => {
      if (upgrade) { request.onupgradeneeded(); return }
      if (blocked) { request.onblocked(); return }
      request.result = { version, objectStoreNames: { contains: name => name === "meta" }, close() { closed++ }, transaction(name, mode) {
        calls.push([name, mode]); const tx = { objectStore() { return { get(key) {
          calls.push(key); const read = {}; queueMicrotask(() => { read.result = { value: marker }; read.onsuccess(); tx.oncomplete() }); return read
        } } } }; return tx
      } }; request.onsuccess()
    }); return request
  } }
  return { factory, calls, stats: () => ({ closed, aborted }) }
}
const preflight = loadTS("acceptance/preflight.ts").preflightAcceptanceDb
test("fresh native preflight lists only; existing registered v3 uses readonly/no-version open then closes", async () => {
  const fresh = nativeDb({ exists: false }); await preflight(fresh.factory, spec); assert.deepEqual(fresh.calls, ["list"])
  const existing = nativeDb(); await preflight(existing.factory, spec); assert.deepEqual(existing.calls[1], [guard.ACCEPTANCE_DB_NAME, undefined])
  assert.deepEqual(existing.calls[2], ["meta", "readonly"]); assert.equal(existing.stats().closed, 1)
})
test("native preflight refuses unsupported enumeration, unknown markers, old versions, blocked or raced-upgrade stores", async () => {
  await assert.rejects(preflight({}, spec), /枚举/)
  for (const options of [{ marker: { unknown: true } }, { version: 20 }, { upgrade: true }, { blocked: true }]) {
    const h = nativeDb(options); await assert.rejects(preflight(h.factory, spec)); if (options.upgrade) assert.equal(h.stats().aborted, 1)
  }
})
test("acceptance boot checks gate/token/native preflight before dynamically importing any business or Vue module", () => {
  const entrySource = fs.readFileSync(path.join(__dirname, "../src/acceptance/entry.ts"), "utf8")
  assert.ok(entrySource.indexOf("await preflightAcceptanceDb") < entrySource.indexOf('await import("./mount")'))
  assert.match(entrySource, /confirmed\?\.checked/); assert.match(entrySource, /quire_access_token/)
  assert.doesNotMatch(entrySource, /import .*db\/|from "vue"|src\/main|localStorage\.removeItem|clearAccessToken/)
})
test("dedicated config changes only acceptance db export, requires daily origin and blocks normal boot/API with strict port", () => {
  const cfg = fs.readFileSync(path.join(__dirname, "../vite.p4-acceptance.config.ts"), "utf8")
  assert.match(cfg, /process.env.P4_DAILY_ORIGIN/); assert.match(cfg, /strictPort: true/); assert.match(cfg, /enforce: "pre"/)
  assert.match(cfg, /new QuireDb\("quire-p4-acceptance"\)/); assert.match(cfg, /dist-p4-acceptance/)
  assert.match(cfg, /\/src\/main.ts/); assert.doesNotMatch(cfg, /target:.*8000/)
  const schema = fs.readFileSync(path.join(__dirname, "../src/db/schema.ts"), "utf8")
  assert.match(schema, /constructor\(name = "quire"\)/); assert.match(schema, /export const db = new QuireDb\(\)/)
})
test("fixture/page offer no reset, real account, background sync or automatic fixture creation", () => {
  const read = name => fs.readFileSync(path.join(__dirname, "../src/acceptance", name), "utf8")
  const page = read("AcceptancePage.vue"); assert.match(page, /await canLeave\(\)/); assert.match(page, /await seedAcceptance\(props.spec\)/)
  assert.match(page, /不提供清库按钮/); assert.doesNotMatch(page, /onMounted.*seed|runSync|router|deleteDatabase|\.clear\(/)
  assert.doesNotMatch(read("fixtures.ts"), /fetch\(|\.clear\(|bulkDelete|deleteDatabase/)
  assert.doesNotMatch(read("mount.ts"), /main|router|runSync|mediaMaintenance/)
})
