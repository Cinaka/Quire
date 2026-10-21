import type { NotebookReadLease, NotebookReadPort } from "@/db/notebookReadCore"
export interface NotebookAuth { subject: string; generation: number; expiresAt: number }
export interface NotebookOwner { ownerUserId: string; generation: string }
export interface NotebookGateIO {
  auth(): NotebookAuth
  owner(): Promise<NotebookOwner>
  verify(subject: string): Promise<{ id: string }>
  open(lease: NotebookReadLease): NotebookReadPort
  now(): number
}
/** Memory-only proof. UI cannot supply a lease to the public production factory. */
export function createNotebookIdentityGate(io: NotebookGateIO) {
  let proof: NotebookReadLease | null = null, epoch = 0
  const ports = new Map<NotebookReadPort, () => void>()
  const validAuth = (lease: NotebookReadLease): boolean => {
    const auth = io.auth()
    return auth.subject === lease.ownerUserId && auth.generation === lease.authGeneration && auth.expiresAt > io.now()
  }
  function invalidate(): void {
    epoch += 1; proof = null
    for (const [port, failed] of [...ports]) {
      ports.delete(port); port.close(); try { failed() } catch { /* clear all ports even if a consumer fails */ }
    }
  }
  async function current(lease: NotebookReadLease): Promise<boolean> {
    if (!validAuth(lease)) return false
    const owner = await io.owner()
    return validAuth(lease) && owner.ownerUserId === lease.ownerUserId && owner.generation === lease.generation
  }
  async function revalidate(): Promise<void> {
    const saved = proof, version = epoch
    if (!saved) return
    try { if (!await current(saved) && epoch === version) invalidate() }
    catch { if (epoch === version) invalidate() }
  }
  function authChanged(): void {
    if (proof && !validAuth(proof)) invalidate()
  }
  async function open(failed: () => void): Promise<NotebookReadPort> {
    const version = epoch, auth = io.auth()
    if (!auth.subject) throw new Error("登录并联网核验后可进入简册；普通列表仍可使用。")
    const owner = await io.owner()
    if (version !== epoch || auth.subject !== io.auth().subject || auth.generation !== io.auth().generation) throw new Error("登录上下文已变化，请重试。")
    if (owner.ownerUserId !== auth.subject) throw new Error("本机归属与账号不同；请到云笺明确处理，不会自动认领或重置。")
    const lease = { ownerUserId: auth.subject, generation: owner.generation, authGeneration: auth.generation }
    if (!proof || !await current(proof)) {
      // Expired access may be refreshed by the existing pinned /auth/me transport.
      const user = await io.verify(auth.subject)
      if (user.id !== auth.subject) throw new Error("登录身份不一致，未打开简册。")
    }
    if (version !== epoch || !await current(lease)) throw new Error("登录、归属或恢复上下文已变化，未打开简册。")
    proof = lease
    const inner = io.open(lease)
    const port: NotebookReadPort = { ...inner, close() { ports.delete(port); inner.close() } }
    ports.set(port, failed)
    return port
  }
  return { open, invalidate, revalidate, authChanged }
}
