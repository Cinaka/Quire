import { utcNow } from "@/shared/time"
import type { Entry } from "@/shared/types"

import { db } from "./schema"

export interface SyncConflict {
  at: string
  server: Entry
}

export interface SyncErrorItem {
  kind: string
  id: string
  message?: string
  count: number
  at: string
}

export interface SyncStatus {
  ownerUserId: string
  lastSyncAt: string
  dirtyTotal: number
  conflictCount: number
  errorCount: number
}

function arrayValue<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
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
    return {
      ownerUserId: typeof owner?.value === "string" ? owner.value : "",
      lastSyncAt: typeof cursor?.value === "string" ? cursor.value : "",
      dirtyTotal: entries + tags + media,
      conflictCount: arrayValue<SyncConflict>(conflicts?.value).length,
      errorCount: arrayValue<SyncErrorItem>(errors?.value).length,
    }
  },

  async conflicts(): Promise<SyncConflict[]> {
    const row = await db.meta.get("conflicts")
    return arrayValue<SyncConflict>(row?.value)
  },

  async errors(): Promise<SyncErrorItem[]> {
    const row = await db.meta.get("syncErrors")
    return arrayValue<SyncErrorItem>(row?.value)
  },

  async resolveConflict(entryId: string, strategy: "local" | "server"): Promise<void> {
    await db.transaction("rw", db.entries, db.meta, async () => {
      const row = await db.meta.get("conflicts")
      const conflicts = arrayValue<SyncConflict>(row?.value)
      const conflict = [...conflicts].reverse().find((item) => item.server.id === entryId)
      if (!conflict) return

      if (strategy === "server") {
        await db.entries.put({ ...conflict.server, dirty: 0 })
      } else {
        const local = await db.entries.get(entryId)
        if (local) {
          const now = utcNow()
          await db.entries.put({
            ...local,
            updatedAt: now,
            clientUpdatedAt: now,
            dirty: 1,
          })
        }
      }

      await db.meta.put({
        key: "conflicts",
        value: conflicts.filter((item) => item.server.id !== entryId),
      })
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
