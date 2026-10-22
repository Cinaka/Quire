import { liveQuery } from "dexie"

import { accessTokenSubject, getAccessToken, tokenGeneration } from "@/api/tokenStore"
import { createNotebookReadCore, type NotebookReadLease } from "./notebookReadCore"
import { readHostOwner } from "./scheduleHostContext"
import { db } from "./schema"

function accessTokenUnexpired(): boolean {
  try {
    const encoded = getAccessToken().split(".")[1] ?? ""
    const base = encoded.replace(/-/g, "+").replace(/_/g, "/")
    const payload = JSON.parse(atob(base.padEnd(Math.ceil(base.length / 4) * 4, "="))) as { exp?: unknown }
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) && payload.exp * 1000 > Date.now()
  } catch { return false }
}
/** Not exported through @/repo until P5-2 installs the verified-identity gate. */
export function createLocalNotebookReadPort(lease: NotebookReadLease) {
  return createNotebookReadCore({
    read: work => db.transaction("r", db.meta, db.entries, db.media, work),
    owner: readHostOwner,
    auth: () => ({ subject: accessTokenSubject(), generation: tokenGeneration(), valid: accessTokenUnexpired() }),
    entry: id => db.entries.get(id),
    media: id => db.media.get(id),
    observe(ids, changed, failed, mediaIds = []) {
      const sub = liveQuery(async () => {
        await db.meta.bulkGet(["ownerUserId", "ownerGeneration"])
        await db.entries.bulkGet([...ids])
        if (mediaIds.length) await db.media.bulkGet([...mediaIds])
      }).subscribe({ next: changed, error: failed })
      return () => sub.unsubscribe()
    },
  }, lease)
}

