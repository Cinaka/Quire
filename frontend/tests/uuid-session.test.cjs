// Execute the actual session.ts and UUID codec; stub only HTTP, token store and DB dependencies.
// This is not an Axios/server/browser/IndexedDB integration test.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { stripTypeScriptTypes } = require('node:module')
const { test } = require('node:test')

const old = '01a01dfa-6c0a-72a6-a7f5-76323ee01718'
const hex = '01a01dfa6c0a72a6a7f576323ee01718'
const other = '01a01e0ef90574aa894eff02c02fd01a'
const user = id => ({ id, email: 'person@example.com', nickname: '青简', timezone: 'Asia/Shanghai' })
const device = id => ({ id, createdAt: '2026-10-26T00:00:00Z', expiresAt: '2026-10-27T00:00:00Z', current: true })

function actual(relative) {
  return new vm.SourceTextModule(stripTypeScriptTypes(
    fs.readFileSync(path.join(__dirname, '../src', relative), 'utf8'),
  ), { identifier: relative })
}

async function setup(options = {}) {
  const state = { calls: [], tokens: [], auth: { user: user(old), access_token: 'token', expires_in: 60 }, sessions: [], ...options }
  const values = {
    '@/db/schema': { db: { meta: { get: async key => {
      assert.equal(key, 'ownerUserId')
      return state.owner === undefined ? undefined : { key, value: state.owner }
    } } } },
    './checkinCache': { clearCheckinCache: () => {}, currentCheckinCacheOwner: () => '' },
    './request': {
      post: async (url, body) => { state.calls.push(['post', url, body]); return state.auth },
      get: async url => { state.calls.push(['get', url]); return state.sessions },
      del: async url => { state.calls.push(['del', url]); return null },
    },
    './tokenStore': {
      clearAccessToken: () => {}, getAccessToken: () => '', invalidateTokenContext: () => {},
      setAccessToken: value => state.tokens.push(value),
    },
  }
  const codec = actual('shared/uuidHex.ts')
  const session = actual('api/session.ts')
  await session.link(specifier => {
    if (specifier === '@/shared/uuidHex') return codec
    const exports = values[specifier]
    if (!exports) throw Error(`unexpected dependency: ${specifier}`)
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value)
    })
  })
  await session.evaluate()
  return { api: session.namespace, state }
}

test('login canonical user ID becomes hex before token publication', async () => {
  const { api, state } = await setup()
  const value = await api.login('person@example.com', 'password')
  assert.equal(value.id, hex)
  assert.equal(value.nickname, '青简')
  assert.equal(state.auth.user.id, old)
  assert.deepEqual(state.tokens, ['token'])
  assert.deepEqual(state.calls[0], ['post', '/auth/login', { email: 'person@example.com', password: 'password' }])
})

test('registration normalizes uppercase without changing input user', async () => {
  const original = Object.freeze(user(old.toUpperCase()))
  const { api, state } = await setup({ auth: { user: original, access_token: 'registered', expires_in: 60 } })
  const value = await api.register('person@example.com', 'password', 'Asia/Shanghai')
  assert.equal(value.id, hex)
  assert.equal(original.id, old.toUpperCase())
  assert.deepEqual(state.tokens, ['registered'])
})

test('invalid login identity cannot publish a token', async () => {
  const { api, state } = await setup({ auth: { user: user('not-a-uuid'), access_token: 'bad' } })
  await assert.rejects(api.login('person@example.com', 'password'))
  assert.deepEqual(state.tokens, [])
})

test('new account identity requires RFC UUID v7', async () => {
  const v4 = '550e8400e29b41d4a716446655440000'
  const { api, state } = await setup({ auth: { user: user(v4), access_token: 'bad' } })
  await assert.rejects(api.register('person@example.com', 'password', 'Asia/Shanghai'))
  assert.deepEqual(state.tokens, [])
})

test('device sessions normalize without mutating server records', async () => {
  const sessions = [Object.freeze(device(old)), Object.freeze(device(other.toUpperCase()))]
  const { api } = await setup({ sessions })
  const value = await api.listDeviceSessions()
  assert.deepEqual(value.map(item => item.id), [hex, other])
  assert.equal(value[0].current, true)
  assert.equal(sessions[0].id, old)
})

test('duplicate aliases are rejected rather than silently merging sessions', async () => {
  const { api } = await setup({ sessions: [device(old), device(hex)] })
  await assert.rejects(api.listDeviceSessions())
})

test('revoke canonical session uses a normalized hex32 URL', async () => {
  const { api, state } = await setup()
  await api.revokeDeviceSession(old)
  assert.deepEqual(state.calls, [['del', `/auth/sessions/${hex}`]])
})

test('malformed revoke ID is rejected before HTTP', async () => {
  const { api, state } = await setup()
  await assert.rejects(api.revokeDeviceSession('../revoke-others'))
  assert.deepEqual(state.calls, [])
})

test('local owner is not silently migrated or deleted', async () => {
  const { api, state } = await setup({ owner: old })
  assert.equal(await api.localOwnerUserId(), old)
  assert.equal(state.owner, old)
  assert.deepEqual(state.calls, [])
})
