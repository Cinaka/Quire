import type { LocalDate, TiptapDoc } from "@/shared/types"

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

export const localDraftRepo = {
  async get(): Promise<EditorDraft | null> {
    const row = await db.meta.get(DRAFT_KEY)
    return isDraft(row?.value) ? row.value : null
  },

  async save(draft: EditorDraft): Promise<void> {
    await db.meta.put({ key: DRAFT_KEY, value: draft })
  },

  async clear(): Promise<void> {
    await db.meta.delete(DRAFT_KEY)
  },
}
