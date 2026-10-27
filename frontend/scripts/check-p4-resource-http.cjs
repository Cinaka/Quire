/** Test subprocess only: stdin credentials, nonce-gated loopback, no production defaults. */
const assert = require("node:assert/strict")
const { webcrypto } = require("node:crypto")
const { loadTS } = require("../tests/schedules-harness.cjs")
const { setup } = require("../tests/schedules-data-harness.cjs")
const { uuidToHex } = loadTS("shared/uuidHex.ts")
function validateConfig(raw) {
  assert.ok(raw && typeof raw === "object" && !Array.isArray(raw))
  assert.deepEqual(Object.keys(raw).sort(), ["media_id", "nonce", "origin", "other_token", "scenario", "source_id", "token", "user_id"].sort())
  assert.equal(typeof raw.origin, "string")
  const url = new URL(raw.origin)
  assert.equal(url.protocol, "http:"); assert.equal(url.hostname, "127.0.0.1")
  assert.ok(url.port && +url.port >= 1024 && +url.port <= 65535)
  assert.equal(raw.origin, url.origin); assert.equal(url.username + url.password + url.search + url.hash, "")
  const ids = {}
  for (const key of ["source_id", "media_id", "user_id"]) {
    assert.equal(typeof raw[key], "string")
    assert.equal(raw[key], raw[key].toLowerCase())
    ids[key] = uuidToHex(raw[key], true)
  }
  assert.match(raw.nonce, /^[A-Za-z0-9_-]{32,128}$/)
  for (const key of ["token", "other_token"]) assert.match(raw[key], /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  assert.ok(["roundtrip", "stale_image", "unknown_receipt"].includes(raw.scenario))
  return Object.freeze({ ...raw, ...ids })
}
let phase = "configuration"
async function run(raw) {
  phase = "configuration"
  const c = validateConfig(raw), header = { "X-Quire-P4-Test-Run": c.nonce }
  phase = "handshake"
  const handshake = await fetch(c.origin + "/__quire_p4_resource_contract__", {
    headers: header, redirect: "error", signal: AbortSignal.timeout(5000),
  })
  assert.equal(handshake.status, 200)
  assert.deepEqual(await handshake.json(), { kind: "quire-p4-resource-http-test/v1" })
  const root = `/api/v1/schedules/${c.source_id}/review/resources`
  // Raw requests exercise actual backend authentication, not the refresh-cookie flow.
  phase = "backend-authentication"
  for (const [token, status] of [["", 401], ["invalid.jwt.signature", 401], [c.other_token, 404]]) {
    const reply = await fetch(c.origin + root, { headers: { ...header, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      redirect: "error", signal: AbortSignal.timeout(5000) })
    assert.equal(reply.status, status)
    assert.equal((await reply.json()).data, null)
  }
  const storage = new Map(), tokens = loadTS("api/tokenStore.ts", {}, {
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    window: { addEventListener() {} }, atob, btoa,
  })
  tokens.setAccessToken(c.token); assert.equal(tokens.accessTokenSubject(), c.user_id)
  // Lazy require: ordinary test:p4 guard tests do not open sockets or require Axios.
  phase = "frontend-transport"
  const axios = require("axios"), facade = { ...axios,
    create: options => {
      const http = axios.create({ ...options, baseURL: c.origin + "/api/v1", timeout: 5000,
        adapter: "http", proxy: false, maxRedirects: 0, withCredentials: false, headers: header })
      http.interceptors.request.use(config => {
        assert.equal(config.baseURL, c.origin + "/api/v1")
        assert.ok(config.url.startsWith(`/schedules/${c.source_id}/review/resources`))
        assert.equal(config.method, "get"); assert.equal(config.data, undefined)
        return config
      })
      return http
    },
    post: async () => { throw Error("refresh is outside this isolated contract") },
  }
  const h = setup({ axios: { ...facade, default: facade }, "./tokenStore": tokens, "@/api/tokenStore": tokens },
    { crypto: webcrypto, AbortController })
  for (const key of ["./schema", "@/db/schema"]) h.mocks[key].waitForScheduleResourceBytes = promise => promise
  await h.db.meta.put({ key: "ownerUserId", value: c.user_id })
  await h.db.meta.put({ key: "ownerGeneration", value: "p4-http-contract-epoch" })
  const transport = h.load("api/scheduleCloudResourceImageTransport.ts").createScheduleCloudResourceImageTransport()
  const lease = { ownerUserId: c.user_id, generation: "p4-http-contract-epoch", tokenGeneration: tokens.tokenGeneration() }
  phase = "resource-proof"
  const wire = await transport.review(c.source_id, lease)
  const cloud = h.load("shared/scheduleCloudResources.ts").parseScheduleCloudResourceReview(wire, c.source_id)
  const source = { ...cloud.review.schedule, dirty: 1, serverUpdatedAt: "" }
  const entry = { ...cloud.review.entry, dirty: 1, serverUpdatedAt: "" }
  const pending = { ...source, status: "pending", convertedEntryId: null, convertedAt: null }
  const first = { ...entry, content: pending.content, contentText: pending.contentText, tagIds: [], mood: null, weather: null }
  await h.db.schedules.put(source); await h.db.entries.put(entry)
  await h.db.meta.put({ key: "scheduleConversions", value: [{ scheduleId: c.source_id, source: pending, entry: first,
    queuedAt: pending.clientUpdatedAt, ownerUserId: c.user_id, protectedMediaIds: cloud.mediaIds }] })
  await h.db.meta.put({ key: "scheduleConflicts", value: [{ scheduleId: c.source_id, kind: "conversion-entry", localEntry: entry, serverEntry: cloud.review.entry }] })
  for (const row of cloud.tags) await h.db.tags.put({ ...row, dirty: 0 })
  const all = () => structuredClone(Object.fromEntries(Object.entries(h.stores).map(([k, v]) => [k, [...v.rows.values()]])))
  const before = all(), engine = h.load("db/scheduleResourceRepairRepo.ts").createInternalScheduleCloudResourceRepairer(transport)
  phase = "download-prepare"
  const prepared = await engine.prepare(c.source_id, [c.media_id])
  assert.deepEqual(all(), before)
  if (c.scenario !== "roundtrip") {
    assert.equal(prepared.ready, false)
    assert.equal(await h.db.media.get(c.media_id), undefined)
    return { scenario: c.scenario, passed: true, repaired: false }
  }
  assert.equal(prepared.ready, true)
  phase = "confirmed-transaction"
  assert.equal((await engine.repair(prepared.reviewId, false)).repaired, false)
  assert.deepEqual(all(), before)
  assert.equal((await engine.repair(prepared.reviewId, true)).repaired, true)
  phase = "persisted-bytes-and-protection"
  const saved = await h.db.media.get(c.media_id), proof = cloud.media.find(m => m.id === c.media_id)
  for (const [blob, image] of [[saved.blob, proof.original], [saved.thumbBlob, proof.thumbnail]]) {
    assert.equal(blob.size, image.size); assert.equal(blob.type, image.mime)
    const hash = Buffer.from(await webcrypto.subtle.digest("SHA-256", await blob.arrayBuffer())).toString("hex")
    assert.equal(hash, image.sha256)
  }
  const after = all(), archives = after.meta.filter(row => row.key === "scheduleResourceRepairs")
  assert.equal(archives.length, 1); assert.equal(archives[0].value.length, 1)
  assert.equal(archives[0].value[0].meaning, "bytes_repaired_protection_unchanged")
  after.media = []; after.meta = after.meta.filter(row => row.key !== "scheduleResourceRepairs")
  assert.deepEqual(after, before)
  assert.equal((await engine.repair(prepared.reviewId, true)).repaired, false)
  return { scenario: c.scenario, passed: true, repaired: true }
}
if (require.main === module) {
  let input = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", chunk => { input += chunk; if (input.length > 32768) process.exit(2) })
  process.stdin.on("end", async () => {
    try { const result = await run(JSON.parse(input)); input = ""; process.stdout.write(JSON.stringify(result)) }
    catch { input = ""; process.stderr.write(`P4 isolated HTTP contract failed at ${phase}; no credentials printed\n`); process.exitCode = 1 }
  })
}
module.exports = { validateConfig, run }
