import { db } from "@/db/schema"

import { downloadFullBackup } from "@/capabilities/backupFile"
import { utcNow } from "@/shared/time"

export type ClaimResult =
  | { kind: "claimed"; entries: number; tags: number; media: number }
  | { kind: "sameOwner" }
  | { kind: "ownerMismatch"; localOwner: string }

async function readMeta(key: string): Promise<string> {
  const row = await db.meta.get(key)
  return typeof row?.value === "string" ? row.value : ""
}

export async function claimLocalData(userId: string): Promise<ClaimResult> {
  const owner = await readMeta("ownerUserId")
  if (owner && owner === userId) return { kind: "sameOwner" }
  if (owner && owner !== userId) return { kind: "ownerMismatch", localOwner: owner }

  await downloadFullBackup()
  const counts = await db.transaction("rw", db.entries, db.tags, db.media, db.meta, async () => {
    const entries = await db.entries.toCollection().modify({ dirty: 1 })
    const tags = await db.tags.toCollection().modify({ dirty: 1 })
    const media = await db.media.toCollection().modify({ dirty: 1 })
    await db.meta.put({ key: "ownerUserId", value: userId })
    await db.meta.put({ key: "claimedAt", value: utcNow() })
    return { entries, tags, media }
  })
  return { kind: "claimed", ...counts }
}

export async function resetLocalForNewOwner(userId: string): Promise<void> {
  await downloadFullBackup()
  await db.transaction("rw", db.entries, db.tags, db.media, db.meta, async () => {
    await db.entries.clear()
    await db.tags.clear()
    await db.media.clear()
    await db.meta.clear()
    await db.meta.put({ key: "ownerUserId", value: userId })
  })
}
