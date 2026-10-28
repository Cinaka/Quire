import { clearCheckinCache } from "@/api/checkinCache"
import { clearAccessToken } from "@/api/tokenStore"
import { newId } from "@/shared/ids"
import { commitUuid32Reset, createUuid32Cutover, UUID32_STORAGE_KEY, UUID32_STORAGE_VALUE } from "@/shared/uuidStorageCutover"
import type { UuidStorageProbe } from "@/shared/uuidStorageCutover"
import { db } from "./schema"

/** Probe without opening Dexie v4: cancel must not upgrade or mutate the old database. */
export function probeUuidStorage(name: string): Promise<UuidStorageProbe> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name)
    let absent = false
    request.onupgradeneeded = () => { absent = true; request.transaction?.abort() }
    request.onerror = () => absent ? resolve({ exists: false, version: 0, marker: undefined }) : reject(request.error)
    request.onblocked = () => reject(new Error("本地库检查被其他页面占用，请先关闭其他青简页面"))
    request.onsuccess = () => {
      const source = request.result, version = source.version
      if (!source.objectStoreNames.contains("localFormat")) {
        source.close(); resolve({ exists: true, version, marker: undefined }); return
      }
      const tx = source.transaction("localFormat", "readonly")
      const read = tx.objectStore("localFormat").get(UUID32_STORAGE_KEY)
      tx.oncomplete = () => { source.close(); resolve({ exists: true, version, marker: read.result?.value }) }
      tx.onabort = () => { source.close(); reject(tx.error ?? new Error("无法检查本地身份格式")) }
      tx.onerror = () => { /* abort handler owns the result */ }
    }
  })
}
export const prepareUuid32Storage = createUuid32Cutover({
  probe: () => probeUuidStorage(db.name),
  invalidateSession: () => { clearCheckinCache(); clearAccessToken() },
  open: () => db.open(),
  verifyReady: async () => {
    if ((await db.localFormat.get(UUID32_STORAGE_KEY))?.value !== UUID32_STORAGE_VALUE) throw new Error("本地 UUID32 初始化未确认；应用尚未启动")
  },
  reset: consented => db.transaction("rw", [db.entries, db.tags, db.media, db.schedules, db.meta, db.localFormat],
    () => commitUuid32Reset(db, consented, newId())),
})
