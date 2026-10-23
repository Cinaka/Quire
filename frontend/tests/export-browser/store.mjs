// Dynamically imported only after the origin/name guard and explicit click.
// Uses the real current QuireDb schema. Its unused default instance is never opened;
// the IDB guard rejects every name except this run's exact random test name.
import { QuireDb } from '../../src/db/schema.ts'
import { databaseName } from './context.mjs'
export const db = new QuireDb(databaseName())
export const writer = new QuireDb(db.name)
export const OWNER = '019b178b-aaaa-7111-8111-111111111111'
export const EPOCH = 'p6-fixed-snapshot-epoch'
let subject = OWNER, generation = 1, expiresAt = Math.floor(Date.now() / 1000) + 3600
export function resetAuth() { subject = OWNER; generation = 1; expiresAt = Math.floor(Date.now() / 1000) + 3600 }
export function changeAuth(values) {
  if ('subject' in values) subject = values.subject
  if ('generation' in values) generation = values.generation
  if ('expiresAt' in values) expiresAt = values.expiresAt
}
export function accessTokenSubject() { return subject }
export function tokenGeneration() { return generation }
export function getAccessToken() { return `test.${btoa(JSON.stringify({ sub: subject, exp: expiresAt }))}.unsigned-fixture` }
export async function readHostOwner() {
  const owner = await db.meta.get('ownerUserId'), epoch = await db.meta.get('ownerGeneration')
  if (typeof owner?.value !== 'string' || typeof epoch?.value !== 'string') throw Error('测试meta缺失或类型错误')
  return { ownerUserId: owner.value, generation: epoch.value }
}
