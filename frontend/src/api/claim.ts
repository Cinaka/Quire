// src/api/claim.ts —— 游客数据认领。只在登录成功后调用一次。
import { db } from "@/db/schema"
// @/repo 里没有 exportBackup（P1-5 导出的是 backupRepo.exportAll，而落盘在 capabilities）。
// 两步包成一个函数，见本页第十一节 N2。
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

  // 硬约束第 3 条：认领前先落一份防蠹备份，失败就整个中止（不捕异常）。
  await downloadFullBackup()

  const counts = await db.transaction("rw", db.entries, db.tags, db.media, db.meta, async () => {
    const e = await db.entries.toCollection().modify({ dirty: 1 })
    const t = await db.tags.toCollection().modify({ dirty: 1 })
    const m = await db.media.toCollection().modify({ dirty: 1 })
    await db.meta.put({ key: "ownerUserId", value: userId })
    // 注意：这里不写 lastSyncAt。游标只能在 bootstrap 的 push 全部成功后才写。
    await db.meta.put({ key: "claimedAt", value: utcNow() })
    return { entries: e, tags: t, media: m }
  })

  return { kind: "claimed", ...counts }
}
