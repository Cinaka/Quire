export type DownloadAcceptancePause = "proof" | "image" | "transaction"
let transactionWait: (() => Promise<void>) | null = null
/** Dedicated-build hook only; normal schema.ts never imports or invokes this module. */
export async function waitForDownloadAcceptanceTransaction<T>(promise: Promise<T>): Promise<T> {
  const hook = transactionWait, result = await promise
  if (hook) await hook()
  return result
}
export function createDownloadAcceptanceBarrier(changed: (point: DownloadAcceptancePause | null) => void) {
  if (transactionWait) throw new Error("已有图片下载验收会话，先关闭旧会话")
  let active = true, armed: DownloadAcceptancePause | null = null, waiting = false, release: (() => void) | null = null
  const resume = () => { const done = release; release = null; if (waiting) { waiting = false; changed(null) }; done?.() }
  const wait = async (point: DownloadAcceptancePause) => {
    if (!active || armed !== point) return
    armed = null
    const pending = new Promise<void>(resolve => { release = resolve })
    waiting = true; changed(point); await pending
  }
  const hook = () => wait("transaction")
  transactionWait = hook
  return {
    wait,
    arm(point: DownloadAcceptancePause) { if (!active || waiting) return false; armed = point; return true },
    release: resume,
    cancel() { armed = null; resume() },
    dispose() { active = false; armed = null; resume(); if (transactionWait === hook) transactionWait = null },
  }
}
