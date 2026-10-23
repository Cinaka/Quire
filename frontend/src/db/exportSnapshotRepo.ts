import Dexie, { liveQuery } from "dexie"
import { accessTokenSubject, getAccessToken, tokenGeneration } from "@/api/tokenStore"
import { db } from "./schema"
import { readHostOwner } from "./scheduleHostContext"
import { createExportSnapshotCore } from "./exportSnapshotCore"
import { touchesExportContent } from "@/shared/exportContentMutation"
import type { NotebookReadLease } from "./notebookReadCore"

function validAccess(): boolean {
  try {
    const encoded = getAccessToken().split(".")[1] ?? "", base = encoded.replace(/-/g, "+").replace(/_/g, "/")
    const payload = JSON.parse(atob(base.padEnd(Math.ceil(base.length / 4) * 4, "="))) as { exp?: unknown }
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) && payload.exp * 1000 > Date.now()
  } catch { return false }
}
/** Internal only. Never accepts a lease from a view or exposes a raw data reader. */
export function createLocalExportSnapshotPort(lease: NotebookReadLease) {
  return createExportSnapshotCore({
    // Force a physical read-only transaction, never join an ambient rw transaction.
    read: work => db.transaction("r!", db.meta, db.entries, db.tags, db.media, work),
    owner: () => {
      const tx = Dexie.currentTransaction
      return tx?.db === db && tx.mode === "readonly" && tx.storeNames.includes("meta")
        ? readHostOwner() : db.transaction("r!", db.meta, readHostOwner)
    },
    auth: () => ({ subject: accessTokenSubject(), generation: tokenGeneration(), valid: validAccess() }),
    async scan(plan, visit) {
      if (plan.emptyIntersection) return
      if (plan.scope.kind === "entry") { const row = await db.entries.get(plan.scope.id); if (row) visit(row); return }
      await db.entries.where("[isDeleted+entryDate]").between(
        [0, plan.from ?? "0001-01-01"], [0, plan.to ?? "9999-12-31"], true, true,
      ).each(visit)
    },
    tag: id => db.tags.get(id), media: id => db.media.get(id),
    observeIdentity(changed, failed) {
      const sub = liveQuery(readHostOwner).subscribe({ next: changed, error: failed })
      return () => sub.unsubscribe()
    },
    observeContent(changed, failed) {
      const mutated = (parts: Parameters<typeof touchesExportContent>[1]) => {
        try { if (touchesExportContent(db.name, parts)) changed() } catch { failed() }
      }
      Dexie.on("storagemutated", mutated)
      return () => Dexie.on("storagemutated").unsubscribe(mutated)
    },
    now: Date.now, monotonic: () => performance.now(),
  }, lease)
}
