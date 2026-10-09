import { db } from "@/db/schema"
import {
  assertLocalOwner, localOwnerSnapshot, readScheduleConversions, rotateOwnerGeneration,
} from "@/db/scheduleStateRepo"
import { downloadFullBackup } from "@/capabilities/backupFile"
import { SCHEDULE_META_KEYS } from "@/shared/schedules"
import { scheduleDraftFingerprint } from "@/shared/scheduleDrafts"
import { utcNow } from "@/shared/time"

import { accessTokenSubject, tokenGeneration } from "./tokenStore"

export type ClaimResult =
  | { kind: "claimed"; entries: number; tags: number; media: number; schedules: number }
  | { kind: "sameOwner" }
  | { kind: "ownerMismatch"; localOwner: string }

function assertLogin(userId: string, generation: number): void {
  if (accessTokenSubject() !== userId || tokenGeneration() !== generation) {
    throw new Error("登录账号已变化，认领/切换已停止")
  }
}
async function draftFingerprint(): Promise<string> {
  const row = await db.meta.get(SCHEDULE_META_KEYS.draft)
  return scheduleDraftFingerprint(Boolean(row), row?.value)
}
async function assertDraftUnchanged(expected: string): Promise<void> {
  if (await draftFingerprint() !== expected) {
    throw new Error("备份期间预简草稿已变化，未认领或清库；请重新备份")
  }
}
export async function claimLocalData(userId: string): Promise<ClaimResult> {
  const generation = tokenGeneration()
  assertLogin(userId, generation)
  const owner = await db.transaction("r", db.meta, () => localOwnerSnapshot())
  if (owner.ownerUserId === userId) return { kind: "sameOwner" }
  if (owner.ownerUserId) return { kind: "ownerMismatch", localOwner: owner.ownerUserId }
  const draftBeforeBackup = await db.transaction("r", db.meta, () => draftFingerprint())
  await downloadFullBackup()
  const counts = await db.transaction("rw", db.entries, db.tags, db.media, db.schedules, db.meta, async () => {
    assertLogin(userId, generation)
    await assertLocalOwner(owner)
    await assertDraftUnchanged(draftBeforeBackup)
    const entries = await db.entries.toCollection().modify({ dirty: 1 })
    const tags = await db.tags.toCollection().modify({ dirty: 1 })
    const media = await db.media.toCollection().modify({ dirty: 1 })
    const schedules = await db.schedules.toCollection().modify({ dirty: 1 })
    const queued = await readScheduleConversions()
    await db.meta.put({ key: SCHEDULE_META_KEYS.conversions, value: queued.map(item => ({ ...item, ownerUserId: userId })) })
    await db.meta.put({ key: "ownerUserId", value: userId })
    await db.meta.put({ key: "claimedAt", value: utcNow() })
    await rotateOwnerGeneration()
    return { entries, tags, media, schedules }
  })
  return { kind: "claimed", ...counts }
}

export async function resetLocalForNewOwner(userId: string): Promise<void> {
  const generation = tokenGeneration()
  assertLogin(userId, generation)
  const owner = await db.transaction("r", db.meta, () => localOwnerSnapshot())
  const draftBeforeBackup = await db.transaction("r", db.meta, () => draftFingerprint())
  await downloadFullBackup()
  await db.transaction("rw", db.entries, db.tags, db.media, db.schedules, db.meta, async () => {
    assertLogin(userId, generation)
    await assertLocalOwner(owner)
    await assertDraftUnchanged(draftBeforeBackup)
    await db.entries.clear()
    await db.tags.clear()
    await db.media.clear()
    await db.schedules.clear()
    await db.meta.clear()
    await db.meta.put({ key: "ownerUserId", value: userId })
    await rotateOwnerGeneration()
  })
}
