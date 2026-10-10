import { db } from "@/db/schema"
import { getAccessToken, tokenGeneration } from "@/api/tokenStore"
import { newId } from "@/shared/ids"
import { addLocalDays, todayLocal, utcNow } from "@/shared/time"
import { CONTENT_SCHEMA_VERSION, type Schedule } from "@/shared/types"
import { isBackupSchedule } from "@/shared/scheduleBackup"
import { ACCEPTANCE_DB_NAME, ACCEPTANCE_MARKER, acceptanceMarker, assertAcceptanceLocation, isAcceptanceMarker, type AcceptanceSpec } from "./guard"

function guard(spec: AcceptanceSpec, generation: number): void {
  assertAcceptanceLocation(spec, window.location)
  if (db.name !== ACCEPTANCE_DB_NAME) throw new Error("数据库不是专用验收库，未访问日常quire库")
  if (getAccessToken() || tokenGeneration() !== generation) throw new Error("本批验收只允许游客；已有token/身份变化时拒绝，不清理真实凭据")
}
async function empty(): Promise<void> {
  for (const table of [db.entries, db.tags, db.media, db.schedules]) if (await table.toCollection().count()) throw new Error("验收库已有数据，夹具不追加/覆盖/清除；请保留现有验收数据")
  const metadata = await db.meta.toArray()
  if (metadata.some(row => row.key !== ACCEPTANCE_MARKER)) throw new Error("验收库已有其他元信息或草稿，夹具未覆盖")
}
export async function initializeAcceptance(spec: AcceptanceSpec): Promise<void> {
  spec = { ...spec }; const generation = tokenGeneration(); guard(spec, generation)
  await db.transaction("rw", db.entries, db.tags, db.media, db.schedules, db.meta, async () => {
    guard(spec, generation)
    const marker = await db.meta.get(ACCEPTANCE_MARKER)
    if (marker) { if (!isAcceptanceMarker(marker.value, spec)) throw new Error("验收标记不属于本次origin，未接管") }
    else { await empty(); await db.meta.add({ key: ACCEPTANCE_MARKER, value: acceptanceMarker(spec) }) }
    guard(spec, generation)
  })
}
/** 用户明确点击后，空验收库一次性创建三个文本来源和一份首存原稿。没有reset/delete或网络。 */
export async function seedAcceptance(spec: AcceptanceSpec): Promise<void> {
  spec = { ...spec }; const generation = tokenGeneration(); guard(spec, generation)
  await db.transaction("rw", db.entries, db.tags, db.media, db.schedules, db.meta, async () => {
    guard(spec, generation)
    const marker = await db.meta.get(ACCEPTANCE_MARKER)
    if (!isAcceptanceMarker(marker?.value, spec)) throw new Error("缺少本次隔离标记，拒绝创建夹具")
    await empty()
    const today = todayLocal(); const now = utcNow()
    const content = (text: string) => ({ schemaVersion: CONTENT_SCHEMA_VERSION, doc: { type: "doc" as const, content: [{ type: "paragraph", content: [{ type: "text", text }] }] } })
    const cases: [string, string][] = [["今日待刻", today], ["昨日逾期待刻", addLocalDays(today, -1)], ["未来预简", addLocalDays(today, 2)]]
    for (const [label, date] of cases) {
      const row: Schedule = { id: newId(), remindDate: date, title: `验收：${label}`, content: content(label), contentText: label,
        status: "pending", convertedEntryId: null, convertedAt: null, createdAt: now, updatedAt: now, clientUpdatedAt: now,
        serverUpdatedAt: "", deletedAt: null, isDeleted: 0, dirty: 1 }
      if (!isBackupSchedule(row)) throw new Error("夹具不符合现有预简格式，事务未提交")
      await db.schedules.add(row)
    }
    await db.meta.add({ key: "draft", value: { entryId: null, entryDate: today, title: "验收：未关联首存原稿", mood: null, weather: null, tagIds: [], doc: content("仅供首存日期分流验收").doc, updatedAt: now } })
    guard(spec, generation)
  })
}
