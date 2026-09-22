import { utcNow } from "@/shared/time"
import type { Entry } from "@/shared/types"

import { db } from "./schema"

const CONFLICT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export interface SyncConflict {
  entryId: string
  at: string
  local: Entry
  server?: Entry
}

export interface SyncErrorItem {
  kind: string
  id: string
  message?: string
  count: number
  at: string
  paused?: boolean
}

export interface PendingSyncItem {
  kind: "entry" | "tag" | "media"
  id: string
  label: string
  detail: string
}

export interface SyncStatus {
  ownerUserId: string
  lastSyncAt: string
  dirtyEntries: number
  dirtyTags: number
  dirtyMedia: number
  dirtyTotal: number
  conflictCount: number
  errorCount: number
}

function arrayValue<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function rawConflictId(value: unknown): string {
  if (!value || typeof value !== "object") return ""
  const row = value as { entryId?: unknown; local?: Entry; server?: Entry }
  if (typeof row.entryId === "string") return row.entryId
  return row.local?.id ?? row.server?.id ?? ""
}

function activeConflictRows(value: unknown): {
  rows: Array<Record<string, unknown>>
  pruned: boolean
} {
  const raw = arrayValue<Record<string, unknown>>(value)
  const cutoff = Date.now() - CONFLICT_RETENTION_MS
  const rows = raw.filter((row) => {
    if (typeof row.at !== "string") return true
    const timestamp = Date.parse(row.at)
    return Number.isNaN(timestamp) || timestamp >= cutoff
  })
  return { rows, pruned: rows.length !== raw.length }
}

async function persistPrunedConflicts(value: unknown): Promise<Array<Record<string, unknown>>> {
  const active = activeConflictRows(value)
  if (active.pruned) await db.meta.put({ key: "conflicts", value: active.rows })
  return active.rows
}

async function normalizeConflicts(value: unknown): Promise<SyncConflict[]> {
  const rows = arrayValue<Record<string, unknown>>(value)
  const result: SyncConflict[] = []
  for (const row of rows) {
    const id = rawConflictId(row)
    if (!id) continue
    const server = row.server as Entry | undefined
    const storedLocal = row.local as Entry | undefined
    const local = storedLocal ?? (await db.entries.get(id)) ?? server
    if (!local) continue
    result.push({
      entryId: id,
      at: typeof row.at === "string" ? row.at : utcNow(),
      local,
      server,
    })
  }
  return result
}

export const localSyncRepo = {
  async status(): Promise<SyncStatus> {
    const [owner, cursor, entries, tags, media, conflicts, errors] = await Promise.all([
      db.meta.get("ownerUserId"),
      db.meta.get("lastSyncAt"),
      db.entries.where("dirty").equals(1).count(),
      db.tags.where("dirty").equals(1).count(),
      db.media.where("dirty").equals(1).count(),
      db.meta.get("conflicts"),
      db.meta.get("syncErrors"),
    ])
    const activeConflicts = await persistPrunedConflicts(conflicts?.value)
    return {
      ownerUserId: typeof owner?.value === "string" ? owner.value : "",
      lastSyncAt: typeof cursor?.value === "string" ? cursor.value : "",
      dirtyEntries: entries,
      dirtyTags: tags,
      dirtyMedia: media,
      dirtyTotal: entries + tags + media,
      conflictCount: activeConflicts.length,
      errorCount: arrayValue<SyncErrorItem>(errors?.value).length,
    }
  },

  async pending(): Promise<PendingSyncItem[]> {
    const [entries, tags, media] = await Promise.all([
      db.entries.where("dirty").equals(1).toArray(),
      db.tags.where("dirty").equals(1).toArray(),
      db.media.where("dirty").equals(1).toArray(),
    ])
    return [
      ...entries.map((item): PendingSyncItem => ({
        kind: "entry",
        id: item.id,
        label: item.title || "无题日记",
        detail: `${item.entryDate}${item.isDeleted ? " · 待同步删除" : " · 待上传正文"}`,
      })),
      ...tags.map((item): PendingSyncItem => ({
        kind: "tag", id: item.id, label: `#${item.name}`, detail: "待上传标签",
      })),
      ...media.map((item): PendingSyncItem => ({
        kind: "media",
        id: item.id,
        label: `图片 ${item.id.slice(0, 8)}`,
        detail: `${item.entryId ? "已关联日记" : "未关联"} · ${item.size} bytes`,
      })),
    ]
  },

  async conflicts(): Promise<SyncConflict[]> {
    const row = await db.meta.get("conflicts")
    return normalizeConflicts(await persistPrunedConflicts(row?.value))
  },

  async errors(): Promise<SyncErrorItem[]> {
    const row = await db.meta.get("syncErrors")
    return arrayValue<SyncErrorItem>(row?.value)
  },

  async resolveConflict(entryId: string, strategy: "local" | "server"): Promise<void> {
    await db.transaction("rw", db.entries, db.meta, async () => {
      const row = await db.meta.get("conflicts")
      const raw = activeConflictRows(row?.value).rows
      const conflict = [...(await normalizeConflicts(raw))]
        .reverse()
        .find((item) => item.entryId === entryId)
      if (!conflict) return
      if (strategy === "server") {
        if (!conflict.server) return
        await db.entries.put({ ...conflict.server, dirty: 0 })
      } else {
        const now = utcNow()
        await db.entries.put({
          ...conflict.local,
          updatedAt: now,
          clientUpdatedAt: now,
          dirty: 1,
        })
      }
      await db.meta.put({
        key: "conflicts",
        value: raw.filter((item) => rawConflictId(item) !== entryId),
      })
    })
  },

  async resolveAllConflicts(strategy: "local" | "server"): Promise<number> {
    return db.transaction("rw", db.entries, db.meta, async () => {
      const row = await db.meta.get("conflicts")
      const raw = activeConflictRows(row?.value).rows
      const normalized = await normalizeConflicts(raw)
      const latest = new Map<string, SyncConflict>()
      for (const conflict of normalized) latest.set(conflict.entryId, conflict)

      const resolved = new Set<string>()
      for (const conflict of latest.values()) {
        if (strategy === "server") {
          if (!conflict.server) continue
          await db.entries.put({ ...conflict.server, dirty: 0 })
        } else {
          const now = utcNow()
          await db.entries.put({
            ...conflict.local,
            updatedAt: now,
            clientUpdatedAt: now,
            dirty: 1,
          })
        }
        resolved.add(conflict.entryId)
      }

      await db.meta.put({
        key: "conflicts",
        value: raw.filter((item) => !resolved.has(rawConflictId(item))),
      })
      return resolved.size
    })
  },

  async dismissError(kind: string, id: string): Promise<void> {
    const row = await db.meta.get("syncErrors")
    const errors = arrayValue<SyncErrorItem>(row?.value)
    await db.meta.put({
      key: "syncErrors",
      value: errors.filter((item) => item.kind !== kind || item.id !== id),
    })
  },
}
