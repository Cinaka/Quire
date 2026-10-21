// Imported only after origin guard and explicit click. Authentication is simulated.
import { QuireDb } from "../../src/db/schema"
export const db = new QuireDb(`quire-p5-readcheck-${crypto.randomUUID()}`)
export const OWNER = "019b178b-aaaa-7111-8111-111111111111"
export const EPOCH = "p5-fixed-fixture-epoch"
export function accessTokenSubject(): string { return OWNER }
export function tokenGeneration(): number { return 1 }
export function getAccessToken(): string {
  return `test.${btoa(JSON.stringify({ sub: OWNER, exp: Math.floor(Date.now() / 1000) + 3600 }))}.not-a-signed-token`
}
export async function readHostOwner(): Promise<{ ownerUserId: string; generation: string }> {
  const owner = await db.meta.get("ownerUserId"), epoch = await db.meta.get("ownerGeneration")
  if (typeof owner?.value !== "string" || typeof epoch?.value !== "string") throw new Error("测试归属缺失")
  return { ownerUserId: owner.value, generation: epoch.value }
}
