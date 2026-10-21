const { test } = require("node:test")
const assert = require("node:assert/strict")
const { loadTS } = require("./schedules-harness.cjs")
function jwt(owner, marker = "token") { return `header.${Buffer.from(JSON.stringify({ sub: owner })).toString("base64url")}.${marker}` }
function requestHarness() {
  let token = jwt("A"); let generation = 0; let refreshCalls = 0; let replays = 0; let clearCalls = 0
  let refreshResolve
  const refreshResult = new Promise(resolve => { refreshResolve = resolve })
  const tokens = {
    getAccessToken: () => token,
    accessTokenSubject: (raw = token) => { try { return JSON.parse(Buffer.from(raw.split(".")[1], "base64url").toString()).sub } catch { return "" } },
    tokenGeneration: () => generation,
    setAccessToken: next => { token = next },
    clearAccessToken: () => { clearCalls++; token = ""; generation++ },
  }
  let onRequest; let onError
  const http = {
    interceptors: {
      request: { use: fn => { onRequest = fn } }, response: { use: (_ok, error) => { onError = error } },
    },
    async post(_url, _body, options) { const config = { headers: {}, ...options }; onRequest(config); return { data: { data: "ok" } } },
    async request(config) { onRequest(config); replays++; return { data: { data: "replayed" } } },
  }
  const axios = { create: () => http, post: async () => { refreshCalls++; return refreshResult } }
  const api = loadTS("api/request.ts", { axios: { default: axios, ...axios }, "./tokenStore": tokens })
  const fail = (owner = "A", gen = 0) => onError({ response: { status: 401 },
    config: { headers: {}, _syncOwner: owner, _tokenGeneration: gen }, message: "401" })
  return { api, tokens, fail, resolve: owner => refreshResolve({ data: { data: { access_token: jwt(owner, "fresh") } } }),
    switch: owner => { token = jwt(owner); generation++ }, token: () => token,
    stats: () => ({ refreshCalls, replays, clearCalls }) }
}
test("protected outbound request pins the intended account before setting Authorization", async () => {
  const h = requestHarness()
  assert.equal(await h.api.post("/sync/push", {}, "A"), "ok")
  h.switch("B")
  await assert.rejects(h.api.post("/sync/push", {}, "A"), /账号已变化/)
  assert.equal(h.stats().refreshCalls, 0)
})
test("same-account concurrent 401s preserve single-flight refresh and replay", async () => {
  const h = requestHarness()
  const first = h.fail(); const second = h.fail()
  assert.equal(h.stats().refreshCalls, 1)
  h.resolve("A")
  await first; await second
  assert.equal(h.stats().refreshCalls, 1); assert.equal(h.stats().replays, 2)
  assert.equal(h.stats().clearCalls, 0)
})
test("old refresh response cannot install A token or log out B after switching", async () => {
  const h = requestHarness(); const pending = h.fail()
  h.switch("B"); const before = h.token(); h.resolve("A")
  await assert.rejects(pending)
  assert.equal(h.token(), before); assert.equal(h.stats().clearCalls, 0); assert.equal(h.stats().replays, 0)
})
test("stale protected 401 is rejected without refreshing or replaying under a new account", async () => {
  const h = requestHarness(); h.switch("B")
  await assert.rejects(h.fail("A", 0))
  assert.equal(h.stats().refreshCalls, 0); assert.equal(h.stats().replays, 0)
})
test("real token store changes generation on identity/exit but not same-owner refresh", () => {
  let value = jwt("A"); let storageListener
  const api = loadTS("api/tokenStore.ts", {}, {
    localStorage: { getItem: () => value, setItem: (_k, v) => { value = v }, removeItem: () => { value = "" } },
    window: { addEventListener: (_name, fn) => { storageListener = fn } }, atob,
  })
  api.getAccessToken(); const initial = api.tokenGeneration()
  api.setAccessToken(jwt("A", "refreshed")); assert.equal(api.tokenGeneration(), initial)
  api.setAccessToken(jwt("B")); assert.equal(api.tokenGeneration(), initial + 1)
  api.clearAccessToken(); assert.equal(api.tokenGeneration(), initial + 2)
  storageListener({ key: "quire_access_token", newValue: jwt("C") })
  assert.equal(api.accessTokenSubject(), "C"); assert.equal(api.tokenGeneration(), initial + 3)
})
