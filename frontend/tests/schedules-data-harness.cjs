const { AsyncLocalStorage } = require("node:async_hooks")
const { loadTS } = require("./schedules-harness.cjs")
const ID = "019a0300-1234-7000-8000-000000000001"
const OTHER_ID = "019a0300-1234-7000-8000-000000000002"
const AT = "2026-10-08T10:00:00.000Z"
const content = text => ({ schemaVersion: 1, doc: { type: "doc", content: [
  { type: "paragraph", content: [{ type: "text", text }] },
] } })
const schedule = extra => ({
  id: ID, remindDate: "2026-10-09", title: "预简", content: content("计划"), contentText: "计划",
  status: "pending", convertedEntryId: null, convertedAt: null,
  createdAt: AT, updatedAt: AT, clientUpdatedAt: AT, serverUpdatedAt: "",
  deletedAt: null, isDeleted: 0, dirty: 1, ...extra,
})
const entry = extra => ({
  id: ID, entryDate: "2026-10-09", sortOrder: 0, title: "日记", content: content("写成"), contentText: "写成",
  mood: null, weather: null, tagIds: [], fromScheduleId: ID,
  createdAt: AT, updatedAt: AT, clientUpdatedAt: AT, serverUpdatedAt: "",
  deletedAt: null, isDeleted: 0, dirty: 1, ...extra,
})
const terminal = extra => schedule({ status: "converted", convertedEntryId: ID, convertedAt: AT, ...extra })
const intent = extra => ({ scheduleId: ID, source: schedule(), entry: entry(), queuedAt: AT, ...extra })
function backup(extra = {}) {
  const schedules = extra.schedules ?? []
  const entries = extra.entries ?? []
  const tags = extra.tags ?? []
  const media = extra.media ?? []
  return { app: "quire", formatVersion: 3, exportedAt: AT, contentSchemaVersion: 1,
    counts: { entries: entries.length, tags: tags.length, media: media.length, schedules: schedules.length },
    entries, tags, media, schedules, scheduleConversions: [], ...extra }
}
function multiDB() {
  const txStorage = new AsyncLocalStorage()
  const stores = {}
  let queue = Promise.resolve()
  let failName = ""
  let failAt = ""
  const clone = value => value === undefined ? undefined : structuredClone(value)
  function scope(name) {
    const context = txStorage.getStore()
    if (context && !context.tables.has(stores[name])) throw new Error(`table outside transaction: ${name}`)
  }
  function trip(name, operation) {
    scope(name)
    if (failName === name && failAt === operation) { failName = ""; throw new Error("injected storage failure") }
  }
  for (const name of ["entries", "tags", "media", "schedules", "meta"]) {
    const rows = new Map()
    const key = name === "meta" ? "key" : "id"
    function collection(predicate = () => true) {
      const selected = () => { scope(name); return [...rows.values()].filter(predicate) }
      return {
        toArray: async () => selected().map(clone), count: async () => selected().length,
        primaryKeys: async () => selected().map(row => row[key]),
        first: async () => clone(selected()[0]),
        and: next => collection(row => predicate(row) && next(row)),
        async modify(patch) {
          trip(name, "modify")
          const items = selected()
          for (const row of items) Object.assign(row, patch)
          return items.length
        },
      }
    }
    stores[name] = {
      rows, async get(id) { scope(name); return clone(rows.get(id)) },
      async add(row) { trip(name, "put"); if (rows.has(row[key])) throw new Error("duplicate ID"); rows.set(row[key], clone(row)) },
      async put(row) { trip(name, "put"); rows.set(row[key], clone(row)) },
      async update(id, patch) { trip(name, "put"); if (!rows.has(id)) return 0; Object.assign(rows.get(id), clone(patch)); return 1 },
      async delete(id) { trip(name, "delete"); rows.delete(id) },
      async clear() { trip(name, "clear"); rows.clear() },
      async bulkDelete(ids) { trip(name, "delete"); for (const id of ids) rows.delete(id) },
      async bulkGet(ids) { scope(name); return ids.map(id => clone(rows.get(id))) },
      toArray: async () => { scope(name); return [...rows.values()].map(clone) },
      toCollection: () => collection(), orderBy: () => collection(),
      where: index => ({ equals: value => collection(row => {
        if (index.startsWith("[") && index.endsWith("]")) {
          const key = index.slice(1, -1).split("+").map(name => row[name])
          return JSON.stringify(key) === JSON.stringify(value)
        }
        return Array.isArray(row[index]) ? row[index].includes(value) : row[index] === value
      }) }),
    }
  }
  const db = { ...stores, transaction(...args) {
    const fn = args.at(-1)
    const tables = new Set(args.slice(1, -1).flat())
    const parent = txStorage.getStore()
    if (parent) {
      if ([...tables].some(table => !parent.tables.has(table))) {
        return Promise.reject(new Error("nested transaction requests a table outside its parent"))
      }
      return fn()
    }
    const task = queue.then(() => txStorage.run({ db, tables }, async () => {
      const snapshots = Object.fromEntries(Object.entries(stores).map(([name, store]) => [name, clone(store.rows)]))
      try { return await fn() } catch (error) {
        for (const [name, store] of Object.entries(stores)) {
          store.rows.clear()
          for (const [key, row] of snapshots[name]) store.rows.set(key, row)
        }
        throw error
      }
    }))
    queue = task.catch(() => {})
    return task
  } }
  return { db, stores, failNext: (name, operation = "put") => { failName = name; failAt = operation } }
}
function setup(extraMocks = {}, extraGlobals = {}) {
  const memory = multiDB()
  let next = 100
  let user = "account-a"
  let gen = 0
  const ids = { newId: () => `019a0300-1234-7000-8000-${String(++next).padStart(12, "0")}` }
  const tokens = { accessTokenSubject: () => user, tokenGeneration: () => gen }
  const mocks = {
    "./schema": { db: memory.db }, "@/db/schema": { db: memory.db },
    "@/shared/ids": ids, "@/shared/tags": { normalizeTagName: name => name.trim().toLowerCase() },
    "./mediaRepo": { localMediaRepo: { reconcileAll: async () => 0 } },
    "./tokenStore": tokens, ...extraMocks,
  }
  class Reader {
    readAsDataURL(blob) {
      blob.arrayBuffer().then(buffer => {
        this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`
        this.onload()
      }).catch(error => { this.error = error; this.onerror() })
    }
  }
  const load = relative => loadTS(relative, mocks, { FileReader: Reader, atob, btoa, ...extraGlobals })
  return { ...memory, load, mocks, tokens, user: value => { user = value; gen++ } }
}
module.exports = { ID, OTHER_ID, AT, content, schedule, entry, terminal, intent, backup, setup, multiDB }
