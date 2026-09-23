export type BackgroundSyncState =
  | { phase: "running" }
  | { phase: "success" }
  | { phase: "offline" }
  | { phase: "error"; message: string; retryInSeconds: number }

const EVENT_NAME = "quire:background-sync"

export function emitBackgroundSync(state: BackgroundSyncState): void {
  window.dispatchEvent(new CustomEvent<BackgroundSyncState>(EVENT_NAME, { detail: state }))
}

export function onBackgroundSync(
  listener: (state: BackgroundSyncState) => void,
): () => void {
  const handler = (event: Event): void => {
    listener((event as CustomEvent<BackgroundSyncState>).detail)
  }
  window.addEventListener(EVENT_NAME, handler)
  return () => window.removeEventListener(EVENT_NAME, handler)
}
