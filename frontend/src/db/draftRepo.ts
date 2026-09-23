import type { Entry, LocalDate, TiptapDoc } from "@/shared/types"

import { db } from "./schema"

const DRAFT_KEY = "draft"

export interface EditorDraft {
  entryId: string | null
  entryDate: LocalDate
  title: string
  mood: string | null
  weather: string | null
  tagIds: string[]
  doc: TiptapDoc
  updatedAt: string
}

function isDraft(value: unknown): value is EditorDraft {
  if (!value || typeof value !== "object") return false
  const row = value as Partial<EditorDraft>
  return (
    (typeof row.entryId === "string" || row.entryId === null) &&
    typeof row.entryDate === "string" &&
    typeof row.title === "string" &&
    Array.isArray(row.tagIds) &&
    row.doc?.type === "doc" &&
    typeof row.updatedAt === "string"
  )
}

function matchesEntry(draft: EditorDraft, entry: Entry): boolean {
  return (
    draft.entryDate === entry.entryDate &&
    draft.title === entry.title &&
    draft.mood === entry.mood &&
    draft.weather === entry.weather &&
    JSON.stringify(draft.tagIds) === JSON.stringify(entry.tagIds) &&
    JSON.stringify(draft.doc) === JSON.stringify(entry.content?.doc ?? null)
  )
}

export const localDraftRepo = {
  async get(): Promise<EditorDraft | null> {
    const row = await db.meta.get(DRAFT_KEY)
    return isDraft(row?.value) ? row.value : null
  },

  async save(draft: EditorDraft): Promise<void> {
    // 页面卸载时“保存正文”和“保存安全草稿”可能并发完成。若正文已经完整落库，
    // 不再留下同内容草稿，避免下次打开时误报为崩溃恢复。
    if (draft.entryId) {
      const entry = await db.entries.get(draft.entryId)
      if (entry && matchesEntry(draft, entry)) {
        await db.meta.delete(DRAFT_KEY)
        return
      }
    }
    await db.meta.put({ key: DRAFT_KEY, value: draft })
  },

  async clear(): Promise<void> {
    await db.meta.delete(DRAFT_KEY)
  },
}
