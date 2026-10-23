import { createExportPrintLifecycle, type ExportPrintState } from "../shared/exportPrintLifecycle"
import { ExportSnapshotError } from "../shared/exportSnapshot"
// Same-window output: no popup, remote shell, content URL, clone or cross-window
// private channel. Only this adapter calls the platform API / owns isolation DOM.
export function createBrowserExportPrinter(root: HTMLElement, assertCurrent: () => Promise<void>, notify: (state: ExportPrintState) => void, guard?: ReturnType<typeof installExportPrintGuard>) {
  let parent: Node | null = null, next: ChildNode | null = null, disposed = false
  const isolation = guard ?? installExportPrintGuard()
  const life = createExportPrintLifecycle({
    async assertCurrent() { if (disposed || !root.isConnected || !root.childElementCount || typeof window.print !== "function") throw new ExportSnapshotError("EXPORT_PRINT_UNAVAILABLE"); await assertCurrent() },
    enter() {
      if (disposed || !root.isConnected) throw new ExportSnapshotError("EXPORT_PRINT_UNAVAILABLE")
      parent = root.parentNode; next = root.nextSibling
      isolation.surface.append(root); isolation.surface.dataset.armed = "true"
    },
    leave() {
      isolation.surface.dataset.armed = "false"
      if (parent?.isConnected && root.parentNode === isolation.surface) parent.insertBefore(root, next?.parentNode === parent ? next : null)
      parent = null; next = null
    },
    print() { window.print() },
    listen(returned) { window.addEventListener("afterprint", returned); return () => window.removeEventListener("afterprint", returned) },
  }, notify)
  return { ...life, close() { if (disposed) return; life.close(); disposed = true; if (!guard) isolation.close() } }
}
/** Installed for the whole formal route, so browser-menu printing before final
 * confirmation gets an explanatory page, not the app/editor or unchecked draft. */
export function installExportPrintGuard() {
  const surface = document.createElement("div"), message = document.createElement("p"), style = document.createElement("style")
  surface.dataset.quirePrintSurface = ""; surface.dataset.armed = "false"
  message.className = "quire-print-guard-message"; message.textContent = "请返回青简，核对范围与预览后，点击“打印 / 另存 PDF”。当前页面不是已确认的输出。"
  surface.append(message)
  style.textContent = `@media screen { [data-quire-print-surface] {position:fixed;left:-30000px;top:0;pointer-events:none;visibility:hidden} }
@media print {html,body {margin:0!important;padding:0!important;height:auto!important;min-height:0!important;background:white!important}
body > :not([data-quire-print-surface]) {display:none!important}
[data-quire-print-surface] {display:block!important;position:static!important;visibility:visible!important}
[data-quire-print-surface][data-armed="false"] > .quire-print-root {display:none!important}
[data-quire-print-surface][data-armed="true"] > .quire-print-guard-message {display:none!important}
.quire-print-guard-message {font:14pt/1.8 serif;margin:20mm;color:#222}}
`
  document.head.append(style); document.body.append(surface)
  let closed = false
  return { surface, close() { if (closed) return; closed = true; surface.remove(); style.remove() } }
}
