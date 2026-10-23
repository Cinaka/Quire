/** Dexie storagemutated keys are idb://<database>/<table>/<index>.
 * Conservative table-wide signal: unrelated edits in these tables may also prompt.
 * No content/Blob reads, row hashes, schema change or snapshot mutation. */
export function touchesExportContent(database: string, parts: Record<string, unknown>): boolean {
  const tables = ["entries", "tags", "media"]
  return Object.keys(parts).some(key => tables.some(table => key.startsWith(`idb://${database}/${table}/`)))
}
