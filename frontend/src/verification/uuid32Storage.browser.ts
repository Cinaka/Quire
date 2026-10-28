/** Explicit development verification. Uses ONLY a random quire_uuid32_probe_* database. */
import Dexie from "dexie"
import { QuireDb } from "@/db/schema"
import { probeUuidStorage } from "@/db/uuid32Storage"
import { commitUuid32Reset, createUuid32Cutover, UUID32_STORAGE_KEY, UUID32_STORAGE_VALUE } from "@/shared/uuidStorageCutover"

const output = document.getElementById("result")!
const button = document.getElementById("run") as HTMLButtonElement
const ID = "019a0300123470008000000000000001"
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
function log(message: string) { output.textContent += `${message}\n` }
async function run(): Promise<void> {
  button.disabled = true; output.textContent = ""
  const name = `quire_uuid32_probe_${crypto.randomUUID()}`
  if (!name.startsWith("quire_uuid32_probe_")) throw new Error("unsafe test name")
  const old = new Dexie(name), current = new QuireDb(name)
  old.version(3).stores({
    entries: "id, entryDate, updatedAt, isDeleted, dirty, *tagIds, fromScheduleId, [isDeleted+entryDate], [isDeleted+updatedAt]",
    tags: "id, name, dirty", media: "id, entryId, createdAt, dirty, remoteUrl", meta: "key",
    schedules: "id, remindDate, status, updatedAt, dirty, isDeleted, [isDeleted+status+remindDate]",
  })
  try {
    await old.open()
    for (const table of ["entries", "tags", "media", "schedules"]) await old.table(table).put({ id: ID, title: "old-test-data" })
    await old.table("meta").put({ key: "scheduleConversions", value: [{ scheduleId: ID }] })
    old.close()
    const events: string[] = []
    const verifyReady = async () => assert((await current.localFormat.get(UUID32_STORAGE_KEY))?.value === UUID32_STORAGE_VALUE, "format marker missing")
    const gate = createUuid32Cutover({
      probe: () => probeUuidStorage(name), invalidateSession: () => { events.push("invalidate-test-session") },
      open: () => current.open(), verifyReady,
      reset: consent => current.transaction("rw", [...current.tables], () => commitUuid32Reset(current, consent, ID)),
    })
    assert(await gate(() => false) === false, "cancel did not stop")
    assert((await probeUuidStorage(name)).version === 30, "cancel upgraded the database")
    assert(events.length === 0, "cancel invalidated session")
    log("PASS: cancel preserves v3, data and session; no application started")

    await current.open()
    assert(await current.entries.count() === 1, "schema upgrade unexpectedly cleared data")
    const failing = { entries: current.entries, tags: current.tags, media: current.media,
      schedules: current.schedules, meta: current.meta, localFormat: {
        count: () => current.localFormat.count(), get: (key: string) => current.localFormat.get(key),
        clear: () => current.localFormat.clear(), put: async () => { throw new Error("injected format write failure") },
      } }
    let rolledBack = false
    try { await current.transaction("rw", [...current.tables], () => commitUuid32Reset(failing, true, ID)) }
    catch { rolledBack = true }
    assert(rolledBack && await current.entries.count() === 1 && await current.meta.count() === 1, "native transaction did not roll back")
    log("PASS: v4 upgrade itself preserves data; injected reset failure rolls back")

    assert(await gate(() => true), "confirmed gate failed")
    for (const table of [current.entries, current.tags, current.media, current.schedules]) assert(await table.count() === 0, "old entity remained")
    assert(await current.meta.count() === 1 && !(await current.meta.get("scheduleConversions")), "old queues or cursor survived reset")
    await verifyReady()
    log("PASS: confirmed reset clears all business tables and old queues atomically")

    await current.table("entries").put({ id: ID, title: "new-test-data" })
    assert(await gate(() => { throw new Error("second boot prompted") }), "second boot failed")
    assert(await current.entries.count() === 1, "second boot cleared new data")
    log("PASS: second startup keeps newly added UUID32 data")

    const oldVersionDenied = await new Promise<boolean>((resolve, reject) => {
      const request = indexedDB.open(name, 30)
      request.onerror = () => resolve(request.error?.name === "VersionError")
      request.onsuccess = () => { request.result.close(); reject(new Error("old v3 writer reopened")) }
    })
    assert(oldVersionDenied, "old native version writer was not rejected")
    log("PASS: native v3 writer cannot reopen v4 store")
    log("All native IndexedDB checks passed. Production database and credentials untouched.")
  } finally {
    current.close(); old.close()
    await Dexie.delete(name)
    button.disabled = false
  }
}
button.onclick = () => { void run().catch(error => { log(`FAIL: ${String(error)}`); button.disabled = false }) }
