const { test } = require("node:test"), assert = require("node:assert/strict")
const { validateConfig } = require("../scripts/check-p4-resource-http.cjs")
const valid = () => ({ origin: "http://127.0.0.1:49152", nonce: "n".repeat(43),
  source_id: "0198f2a14b3c70008000000000000001", media_id: "0198f2a14b3c70008000abcdef123457",
  user_id: "0198f2a14b3c70008000abcdef123456", token: "header.payload.signature", other_token: "other.payload.signature", scenario: "roundtrip" })
test("HTTP contract configuration is frozen and detached without starting a server", () => {
  const input = valid(), output = validateConfig(input)
  assert.ok(Object.isFrozen(output)); input.origin = "http://example.com"; assert.notEqual(output.origin, input.origin)
})
for (const origin of ["http://localhost:49152", "http://127.0.0.2:49152", "https://127.0.0.1:49152", "http://127.0.0.1:49152/", "http://127.0.0.1:49152/api", "http://127.0.0.1:49152?x", "http://127.0.0.1:49152#x", "http://user@127.0.0.1:49152", "http://127.0.0.1:80", "http://2130706433:49152", "http://example.com:49152", "http://[::1]:49152"])
  test(`contract refuses noncanonical/nonlocal origin ${origin}`, () => assert.throws(() => validateConfig({ ...valid(), origin })))
for (const [key, value] of [["nonce", "short"], ["nonce", "a".repeat(129)], ["token", ""], ["other_token", "Bearer x"], ["source_id", "not-id"], ["user_id", "0198F2A1-4b3c-7000-8000-abcdef123456"], ["media_id", "0198f2a1-4b3c-4000-8000-abcdef123457"], ["scenario", "production"], ["extra", "secret"]])
  test(`contract rejects invalid ${key}`, () => assert.throws(() => validateConfig({ ...valid(), [key]: value })))
for (const scenario of ["roundtrip", "stale_image", "unknown_receipt"])
  test(`contract accepts only explicit scenario ${scenario}`, () => assert.equal(validateConfig({ ...valid(), scenario }).scenario, scenario))
test("contract runner remains test-only, credentials via stdin, refresh deliberately unavailable", () => {
  const fs = require("node:fs"), path = require("node:path"), read = p => fs.readFileSync(path.join(__dirname, "..", p), "utf8")
  const script = read("scripts/check-p4-resource-http.cjs")
  for (const fragment of ["process.stdin", "proxy: false", "maxRedirects: 0", 'adapter: "http"', 'require("axios")', 'createInternalScheduleCloudResourceRepairer', 'engine.repair(prepared.reviewId, false)', 'engine.repair(prepared.reviewId, true)', 'assert.deepEqual(after, before)']) assert.ok(script.includes(fragment))
  for (const file of ["src/repo/index.ts", "src/router/index.ts", "src/api/sync.ts", "package.json"]) assert.equal(read(file).includes("check-p4-resource-http"), false)
})

// Exercises the runner wiring only with simulated fetch/Axios. NOT the real HTTP/JWT suite.
for (const scenario of ["roundtrip", "stale_image", "unknown_receipt"]) test(`runner simulated wiring: ${scenario}`, async () => {
  const { run } = require("../scripts/check-p4-resource-http.cjs"), Module = require("node:module"), crypto = require("node:crypto")
  const { terminal, entry } = require("./schedules-data-harness.cjs"), c = { ...valid(), scenario }
  const jwt = sub => `header.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.signature`
  c.token = jwt(c.user_id); c.other_token = jwt(c.media_id)
  const source = terminal({ id: c.source_id, convertedEntryId: c.source_id })
  const image = { schemaVersion: 1, doc: { type: "doc", content: [{ type: "image", attrs: { src: `local://media/${c.media_id}` } }] } }
  const diary = entry({ id: c.source_id, fromScheduleId: c.source_id, content: image, contentText: "", tagIds: [c.source_id] })
  const sourceWire = { id: source.id, remind_date: source.remindDate, title: source.title, content: source.content, content_text: source.contentText,
    status: source.status, converted_entry_id: source.convertedEntryId, converted_at: source.convertedAt, client_updated_at: source.clientUpdatedAt,
    deleted_at: source.deletedAt, created_at: source.createdAt, updated_at: source.updatedAt }
  const entryWire = { id: diary.id, from_schedule_id: diary.fromScheduleId, entry_date: diary.entryDate, sort_order: diary.sortOrder, title: diary.title,
    content: diary.content, content_text: diary.contentText, mood: null, weather: null, tag_ids: diary.tagIds, client_updated_at: diary.clientUpdatedAt,
    deleted_at: null, created_at: diary.createdAt, updated_at: diary.updatedAt }
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64")
  const proof = { state: "verified", size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), mime: "image/png" }
  const unknown = scenario === "unknown_receipt"
  const wire = { read_only: true, resolution_enabled: false, proof_scope: "current_entry_resources", resource_state: "verified", resources_complete: true,
    review: { read_only: true, reviewable: !unknown, reason: unknown ? "receipt_unknown" : "terminal_review", receipt_known: !unknown,
      first_entry_date: unknown ? null : diary.entryDate, first_entry_deleted: unknown ? null : false, schedule: sourceWire, entry: entryWire, entry_state: "active" },
    media_ids: [c.media_id], tag_ids: [c.source_id], media: [{ id: c.media_id, entry_id: c.source_id, sort_order: 0, width: 1, height: 1,
      size: bytes.length, created_at: diary.createdAt, original: proof, thumbnail: proof }],
    tags: [{ id: c.source_id, name: "当前标签", color: "green", created_at: diary.createdAt }], missing_media_ids: [], missing_tag_ids: [] }
  const previousFetch = global.fetch, previousLoad = Module._load
  const calls = []
  const axios = { create(options) {
    assert.equal(options.adapter, "http"); assert.equal(options.proxy, false); assert.equal(options.maxRedirects, 0)
    const requests = [], responses = []
    return { interceptors: { request: { use: fn => requests.unshift(fn) }, response: { use: fn => responses.push(fn) } },
      async get(url, config) {
        config = { ...options, ...config, url, method: "get", headers: { ...options.headers } }
        for (const fn of requests) config = await fn(config)
        assert.equal(config.headers.Authorization, `Bearer ${c.token}`)
        assert.equal(config.headers["X-Quire-P4-Test-Run"], c.nonce)
        const isImage = /\/(original|thumbnail)$/.test(url); calls.push(isImage)
        if (isImage && scenario === "stale_image") throw Error("simulated stale 409")
        const data = isImage ? { read_only: true, resolution_enabled: false, proof_scope: "current_entry_image_bytes", schedule_id: c.source_id,
          media_id: c.media_id, variant: url.endsWith("/original") ? "original" : "thumbnail", size: proof.size, mime: proof.mime, sha256: proof.sha256, data_base64: bytes.toString("base64") } : wire
        const envelope = { code: 0, message: "ok", data: structuredClone(data) }
        let response = { status: 200, config, data: isImage ? JSON.stringify(envelope) : envelope }
        for (const fn of responses) response = await fn(response)
        return response
      } }
  } }
  Module._load = function(name, ...args) { return name === "axios" ? axios : previousLoad.call(this, name, ...args) }
  global.fetch = async (url, options) => {
    assert.ok(url.startsWith(c.origin + "/")); assert.equal(options.headers["X-Quire-P4-Test-Run"], c.nonce)
    if (url.endsWith("/__quire_p4_resource_contract__")) return { status: 200, json: async () => ({ kind: "quire-p4-resource-http-test/v1" }) }
    return { status: options.headers.Authorization === `Bearer ${c.other_token}` ? 404 : 401, json: async () => ({ data: null }) }
  }
  try {
    assert.deepEqual(await run(c), { scenario, passed: true, repaired: scenario === "roundtrip" })
    assert.equal(calls.filter(Boolean).length, scenario === "roundtrip" ? 2 : scenario === "stale_image" ? 1 : 0)
  } finally { global.fetch = previousFetch; Module._load = previousLoad }
})
