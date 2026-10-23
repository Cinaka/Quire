import { clearExportHandoff, validateExportHandoffScope } from "@/shared/exportHandoff"
import { liveQuery } from "dexie"
import { get } from "@/api/request"
import { accessTokenSubject, getAccessToken, subscribeTokenContext, tokenGeneration } from "@/api/tokenStore"
import { createNotebookIdentityGate } from "@/capabilities/notebookIdentityGate"
import { clearNotebookReturn } from "@/shared/notebookReturn"
import { createLocalNotebookReadPort } from "./notebookReadRepo"
import { readHostOwner } from "./scheduleHostContext"
import { db } from "./schema"

function auth() {
  let expiresAt = 0
  try {
    const encoded = getAccessToken().split(".")[1] ?? "", base = encoded.replace(/-/g, "+").replace(/_/g, "/")
    const payload = JSON.parse(atob(base.padEnd(Math.ceil(base.length / 4) * 4, "="))) as { exp?: unknown }
    if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) expiresAt = payload.exp * 1000
  } catch { /* malformed residual token never proves identity */ }
  return { subject: accessTokenSubject(), generation: tokenGeneration(), expiresAt }
}
const readNotebookOwner = () => db.transaction("r", db.meta, readHostOwner)
const gate = createNotebookIdentityGate({
  auth, owner: readNotebookOwner, now: Date.now,
  verify: subject => {
    if (!navigator.onLine) return Promise.reject(new Error("当前离线且没有本次会话的内存身份核验。"))
    return get<{ id: string }>("/auth/me", undefined, subject)
  },
  open: createLocalNotebookReadPort,
})
let started = false, expiryTimer: ReturnType<typeof setTimeout> | undefined
function scheduleExpiry(): void {
  clearTimeout(expiryTimer)
  const remaining = auth().expiresAt - Date.now()
  if (remaining > 0) expiryTimer = setTimeout(() => { gate.authChanged(); clearNotebookReturn(); clearExportHandoff() }, Math.min(remaining + 1, 2_147_483_647))
}
function start(): void {
  if (started) return
  started = true
  let generation = tokenGeneration()
  subscribeTokenContext(() => {
    if (generation !== tokenGeneration()) { generation = tokenGeneration(); clearNotebookReturn() }
    gate.authChanged(); clearExportHandoff(); scheduleExpiry()
  })
  // Kept across the edit route only as an in-memory identity proof, never a persisted preference.
  liveQuery(readNotebookOwner).subscribe({
    next: () => { void gate.revalidate(); void validateNotebookReturn() },
    error: () => { gate.invalidate(); clearNotebookReturn(); clearExportHandoff() },
  })
  scheduleExpiry()
}
export interface NotebookScope { ownerUserId: string; generation: string; subject: string; authGeneration: number }
export async function captureNotebookScope(): Promise<NotebookScope> {
  start()
  const before = auth(), owner = await readNotebookOwner(), after = auth()
  if (before.subject !== after.subject || before.generation !== after.generation) throw new Error("账号已变化")
  return { ...owner, subject: after.subject, authGeneration: after.generation }
}
// Return capsule validation is read-only; absent/changed scopes discard IDs rather than retarget them.
async function validateNotebookReturn(): Promise<void> {
  try { const { validateNotebookReturnScope } = await import("@/shared/notebookReturn"); const scope = await captureNotebookScope(); validateNotebookReturnScope(scope); validateExportHandoffScope(scope) }
  catch { clearNotebookReturn(); clearExportHandoff() }
}
export async function createVerifiedNotebookReadPort(failed: () => void) {
  start()
  try { const port = await gate.open(failed); scheduleExpiry(); return port }
  catch (error) { throw new Error(`联网核验登录后可进入简册；普通列表仍可使用。${error instanceof Error ? ` ${error.message}` : ""}`) }
}

/** Internal cross-feature capability: shares the same memory-only verified proof.
 * Not exported by @/repo; a view can never provide or receive the lease. */
export async function createVerifiedNotebookCapability<Port extends import("@/capabilities/notebookIdentityGate").IdentityScopedPort>(
  factory: (lease: import("./notebookReadCore").NotebookReadLease) => Port, failed: () => void,
): Promise<Port> {
  start()
  const port = await gate.openCapability(factory, failed)
  scheduleExpiry()
  return port
}
