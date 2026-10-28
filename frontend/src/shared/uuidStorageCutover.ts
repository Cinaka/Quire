import { localUuidHex } from "./uuidHex"

export const UUID32_STORAGE_KEY = "uuidStorageFormat"
export const UUID32_STORAGE_VALUE = "uuid32-v7-reset-v1"
// Dexie multiplies its public version by ten for native IndexedDB.
export const UUID32_NATIVE_VERSION = 40
export interface UuidStorageProbe { exists: boolean; version: number; marker: unknown }
export interface UuidCutoverPort {
  probe(): Promise<UuidStorageProbe>
  invalidateSession(): void
  open(): Promise<unknown>
  verifyReady(): Promise<void>
  reset(consented: boolean): Promise<boolean>
}
function knownMarker(marker: unknown): void {
  if (marker !== undefined && marker !== UUID32_STORAGE_VALUE) throw new Error("本地身份格式未知；未清空数据，请先核对应用版本")
}
/** No app, maintenance, router or network starts until this gate resolves true. */
export function createUuid32Cutover(port: UuidCutoverPort) {
  return async (confirmDiscard: () => boolean | Promise<boolean>): Promise<boolean> => {
    const state = await port.probe()
    if (state.version > UUID32_NATIVE_VERSION) throw new Error("本地数据库来自更新版本；未清空数据")
    knownMarker(state.marker)
    if (state.marker === UUID32_STORAGE_VALUE) {
      await port.open(); await port.verifyReady(); return true
    }
    const consented = state.exists && await confirmDiscard()
    if (state.exists && !consented) return false
    port.invalidateSession()
    await port.open()
    await port.reset(consented)
    await port.verifyReady()
    return true
  }
}
interface CutoverTable {
  clear(): Promise<unknown>
  count(): Promise<number>
}
interface CutoverMeta extends CutoverTable {
  get(key: string): Promise<{ value: unknown } | undefined>
  put(row: { key: string; value: unknown }): Promise<unknown>
}
export interface UuidResetTables {
  entries: CutoverTable; tags: CutoverTable; media: CutoverTable; schedules: CutoverTable
  meta: CutoverMeta; localFormat: CutoverMeta
}
/** Caller MUST wrap all six tables in one rw transaction. No external awaits here. */
export async function commitUuid32Reset(tables: UuidResetTables, consented: boolean, generation: string): Promise<boolean> {
  const marker = (await tables.localFormat.get(UUID32_STORAGE_KEY))?.value
  knownMarker(marker)
  // Another tab may have finished while the confirmation dialog was open.
  if (marker === UUID32_STORAGE_VALUE) return false
  localUuidHex(generation)
  const business = [tables.entries, tables.tags, tables.media, tables.schedules, tables.meta]
  if (!consented) {
    for (const table of business) if (await table.count()) throw new Error("检查后本地数据发生变化；未获清空确认，请刷新后重试")
  }
  for (const table of business) await table.clear()
  await tables.localFormat.clear()
  await tables.meta.put({ key: "ownerGeneration", value: generation })
  // Separate from meta: ordinary account switching must not remove this format marker.
  await tables.localFormat.put({ key: UUID32_STORAGE_KEY, value: UUID32_STORAGE_VALUE })
  return true
}
