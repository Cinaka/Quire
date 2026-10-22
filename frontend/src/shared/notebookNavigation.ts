/** Pure ID navigation: a spread is not physical pagination or even-aligned sheets. */
export function notebookVisibleIds(ids: readonly string[], anchor: string, width: number): string[] {
  const index = Math.max(0, ids.indexOf(anchor))
  return ids.slice(index, index + (width >= 1200 ? 2 : 1))
}
export function notebookTargetIndex(ids: readonly string[], anchor: string, direction: -1 | 1, width: number): number {
  return Math.max(0, ids.indexOf(anchor)) + direction * (width >= 1200 ? 2 : 1)
}
export function notebookKeyAllowed(event: {
  key: string; isComposing: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean
}, editable: boolean, selection: string): boolean {
  return (event.key === "ArrowLeft" || event.key === "ArrowRight") && !event.isComposing &&
    !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !editable && !selection
}
