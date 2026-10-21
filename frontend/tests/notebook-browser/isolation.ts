/** Test tooling only. Never replace modules for other importers. */
export function replacement(source: string, importer: string | undefined, root: string): string | undefined {
  const base = root.replace(/\\/g, "/").replace(/\/$/, "")
  const from = importer?.replace(/\\/g, "/")
  if (from !== `${base}/src/db/notebookReadRepo.ts`) return
  if (!["./schema", "./scheduleHostContext", "@/api/tokenStore", `${base}/src/api/tokenStore`, `${base}/src/api/tokenStore.ts`].includes(source.replace(/\\/g, "/"))) return
  return `${base}/tests/notebook-browser/store.ts`
}
export function testOrigin(location: { protocol: string; hostname: string; port: string }): boolean {
  return location.protocol === "http:" && location.hostname === "127.0.0.1" && location.port === "5183"
}
