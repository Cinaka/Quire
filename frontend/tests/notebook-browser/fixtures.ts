import type { Entry, MediaItem } from "../../src/shared/types"
export const FIRST = "019b178b-0001-7111-8111-111111111111"
export const SECOND = "019b178b-0002-7111-8111-111111111111"
export const DELETED = "019b178b-0003-7111-8111-111111111111"
export const MEDIA = ["019b178b-0011-7111-8111-111111111111", "019b178b-0012-7111-8111-111111111111", "019b178b-0013-7111-8111-111111111111"] as const
const date = "2026-10-21T00:00:00.000Z"
const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] })
function entry(id: string, title: string): Entry {
  return { id, entryDate: "2026-10-21", sortOrder: 0, title, content: null, contentText: "固定测试材料", mood: "🌿", weather: "晴", tagIds: [], fromScheduleId: null, createdAt: date, updatedAt: date, clientUpdatedAt: date, serverUpdatedAt: "", deletedAt: null, isDeleted: 0, dirty: 1 }
}
export function fixtures(): { entries: Entry[]; media: MediaItem[] } {
  const first = entry(FIRST, "只读夹具甲：长标题与本机图片")
  first.content = { schemaVersion: 1, doc: { type: "doc", content: [
    paragraph("首段标记：山色入窗。<script>这必须是文字</script>"),
    ...MEDIA.map((id, i) => ({ type: "image", attrs: { src: `local://media/${id}`, alt: `固定本机图片${i + 1}` } })),
    { type: "image", attrs: { src: "/api/p5-must-not-request", alt: "不允许远程加载" } },
    ...Array.from({ length: 45 }, (_, i) => paragraph(`长文第${i + 1}段：一编青简，半生浮沉。保留自然阅读，不按纸张高度截断。`)),
    paragraph("末段完整标记"),
  ] } }
  const second = entry(SECOND, "只读夹具乙：未知版本仍保留文字")
  second.content = { schemaVersion: 999, doc: { type: "doc", content: [paragraph("乙篇独有标记"), { type: "futureNode", content: [{ type: "text", text: "未知节点的安全文字" }] }] } }
  const deleted = entry(DELETED, "已删除不应出现")
  deleted.isDeleted = 1; deleted.deletedAt = date
  const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), c => c.charCodeAt(0))
  const png = new Blob([bytes], { type: "image/png" })
  const media = MEDIA.slice(0, 2).map((id, i): MediaItem => ({ id, entryId: FIRST, blob: i === 0 ? png : new Blob(), thumbBlob: i === 1 ? png : null, mime: "image/png", width: 1, height: 1, size: i === 0 ? png.size : 0, sortOrder: i, remoteUrl: "/media/p5-must-not-request", thumbRemoteUrl: "", createdAt: date, dirty: 1 }))
  return { entries: [first, second, deleted], media }
}
