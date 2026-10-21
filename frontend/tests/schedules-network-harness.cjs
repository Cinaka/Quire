const { loadTS } = require("./schedules-harness.cjs")
function jwt(owner, marker = "old") { return `header.${Buffer.from(JSON.stringify({ sub: owner })).toString("base64url")}.${marker}` }
function networkHarness(serve) {
  let token = jwt("account-a"), generation = 0, refreshCount = 0, authorize, success, failure
  const calls = []
  const tokens = {
    getAccessToken: () => token,
    accessTokenSubject: (raw = token) => { try { return JSON.parse(Buffer.from(raw.split(".")[1], "base64url").toString()).sub } catch { return "" } },
    tokenGeneration: () => generation,
    setAccessToken: next => { token = next },
    clearAccessToken: () => { token = ""; generation++ },
  }
  async function send(config) {
    authorize(config)
    calls.push(structuredClone(config))
    const response = await serve(config.url, config.data, config, calls.length)
    if (response.status >= 400) return failure({ response, config, message: "private raw SQL/token message" })
    return success({ ...response, config })
  }
  const http = {
    interceptors: { request: { use: fn => { authorize = fn } },
      response: { use: (ok, fail) => { success = ok; failure = fail } } },
    post: (url, data, options) => send({ url, data, headers: {}, ...options }),
    get: (url, options) => send({ url, headers: {}, ...options }),
    request: config => send(config),
  }
  const axios = { create: () => http, post: async () => {
    refreshCount++
    return { data: { data: { access_token: jwt(tokens.accessTokenSubject(), "fresh") } } }
  } }
  const api = loadTS("api/request.ts", { axios: { default: axios, ...axios }, "./tokenStore": tokens })
  return { api, tokens, calls, switch: owner => { token = jwt(owner); generation++ },
    refreshes: () => refreshCount }
}
module.exports = { networkHarness }
