/** P6-only pure selection rules. Not an identity gate or a database snapshot. */
export type ExportScope =
  | { kind: "entry"; id: string }
  | { kind: "day"; date: string }
  | { kind: "month"; month: string }
  | { kind: "year"; year: string }
  | { kind: "range"; from: string; to: string }
  | { kind: "all" }

export interface ExportFilters {
  dateFrom?: string
  dateTo?: string
  keyword?: string
  tagIds?: readonly string[]
  hasImage?: boolean
}
export interface ExportSelectionRequest {
  scope: ExportScope
  /** Only explicitly supplied conditions. Settings entry supplies none. */
  filters?: ExportFilters
}
export interface ExportSelectionPlan {
  readonly scope: Readonly<ExportScope>
  readonly filters: Readonly<ExportFilters>
  readonly from: string | null
  readonly to: string | null
  readonly emptyIntersection: boolean
  readonly order: "entryDateAsc-sortOrderDesc-idAsc"
}
/** Adapter supplies hasImage from current document references, never a cached count.
 * No content, Blob, owner, token, source evidence or draft belongs in this value.
 */
export interface ExportCandidate {
  id: string
  entryDate: string
  sortOrder: number
  title: string
  contentText: string
  tagIds: readonly string[]
  hasImage: boolean
  isDeleted: 0 | 1
  deletedAt: string | null
}
export interface ExportSelectedEntry {
  readonly id: string
  readonly entryDate: string
  readonly sortOrder: number
}
export class ExportSelectionError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.code = code
    this.name = "ExportSelectionError"
  }
}
const fail = (code: string): never => { throw new ExportSelectionError(code) }
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail("INVALID_EXPORT_SELECTION")
}
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u0020\u007f]/.test(value)
const leap = (year: number): boolean => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
function days(year: number, month: number): number {
  return month === 2 ? (leap(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31
}
/** Gregorian calendar arithmetic only: no Date parsing or UTC/local conversion. */
export function validExportDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8))
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days(year, month)
}
const date = (value: unknown): string => validExportDate(value) ? value : fail("INVALID_EXPORT_DATE")
function scopeOf(value: unknown): ExportScope {
  if (!object(value)) return fail("INVALID_EXPORT_SCOPE")
  switch (value.kind) {
    case "all": keys(value, ["kind"]); return { kind: "all" }
    case "entry":
      keys(value, ["kind", "id"])
      if (!id(value.id)) return fail("INVALID_EXPORT_ENTRY_ID")
      return { kind: "entry", id: value.id }
    case "day": keys(value, ["kind", "date"]); return { kind: "day", date: date(value.date) }
    case "month": {
      keys(value, ["kind", "month"])
      if (typeof value.month !== "string" || !/^\d{4}-\d{2}$/.test(value.month) || !validExportDate(`${value.month}-01`)) return fail("INVALID_EXPORT_MONTH")
      return { kind: "month", month: value.month }
    }
    case "year":
      keys(value, ["kind", "year"])
      if (typeof value.year !== "string" || !/^\d{4}$/.test(value.year) || !validExportDate(`${value.year}-01-01`)) return fail("INVALID_EXPORT_YEAR")
      return { kind: "year", year: value.year }
    case "range": {
      keys(value, ["kind", "from", "to"])
      const from = date(value.from), to = date(value.to)
      if (from > to) return fail("REVERSED_EXPORT_RANGE")
      return { kind: "range", from, to }
    }
    default: return fail("INVALID_EXPORT_SCOPE")
  }
}
function filtersOf(value: unknown): ExportFilters {
  if (value === undefined) return {}
  if (!object(value)) return fail("INVALID_EXPORT_FILTERS")
  keys(value, ["dateFrom", "dateTo", "keyword", "tagIds", "hasImage"])
  const result: ExportFilters = {}
  if (value.dateFrom !== undefined) result.dateFrom = date(value.dateFrom)
  if (value.dateTo !== undefined) result.dateTo = date(value.dateTo)
  if (result.dateFrom && result.dateTo && result.dateFrom > result.dateTo) fail("REVERSED_EXPORT_RANGE")
  if (value.keyword !== undefined) {
    if (typeof value.keyword !== "string" || value.keyword.length > 4096) return fail("INVALID_EXPORT_KEYWORD")
    // Preserve list semantics: case-insensitive substring, not regex or trim.
    result.keyword = value.keyword
  }
  if (value.tagIds !== undefined) {
    if (!Array.isArray(value.tagIds) || value.tagIds.length > 100 || !value.tagIds.every(id)) return fail("INVALID_EXPORT_TAG_FILTER")
    result.tagIds = Object.freeze([...new Set(value.tagIds as string[])])
  }
  if (value.hasImage !== undefined) {
    if (typeof value.hasImage !== "boolean") return fail("INVALID_EXPORT_IMAGE_FILTER")
    result.hasImage = value.hasImage
  }
  return result
}
const plans = new WeakSet<object>()
export function compileExportSelection(request: ExportSelectionRequest): ExportSelectionPlan {
  if (!object(request)) return fail("INVALID_EXPORT_SELECTION")
  keys(request, ["scope", "filters"])
  const scope = Object.freeze(scopeOf(request.scope)), filters = Object.freeze(filtersOf(request.filters))
  let from: string | null = null, to: string | null = null
  if (scope.kind === "day") from = to = scope.date
  if (scope.kind === "range") { from = scope.from; to = scope.to }
  if (scope.kind === "year") { from = `${scope.year}-01-01`; to = `${scope.year}-12-31` }
  if (scope.kind === "month") {
    from = `${scope.month}-01`
    to = `${scope.month}-${days(Number(scope.month.slice(0, 4)), Number(scope.month.slice(5)))}`
  }
  if (filters.dateFrom && (!from || filters.dateFrom > from)) from = filters.dateFrom
  if (filters.dateTo && (!to || filters.dateTo < to)) to = filters.dateTo
  const plan = Object.freeze({ scope, filters, from, to, emptyIntersection: Boolean(from && to && from > to), order: "entryDateAsc-sortOrderDesc-idAsc" as const })
  plans.add(plan)
  return plan
}
function assertPlan(plan: ExportSelectionPlan): void {
  if (!plan || !plans.has(plan)) fail("UNCOMPILED_EXPORT_SELECTION")
}
function assertCandidate(row: ExportCandidate): void {
  if (!object(row) || !id(row.id) || !validExportDate(row.entryDate) || !Number.isSafeInteger(row.sortOrder)
    || typeof row.title !== "string" || typeof row.contentText !== "string"
    || !Array.isArray(row.tagIds) || !row.tagIds.every(id) || typeof row.hasImage !== "boolean"
    || (row.isDeleted !== 0 && row.isDeleted !== 1) || (row.deletedAt !== null && typeof row.deletedAt !== "string")) fail("INVALID_EXPORT_CANDIDATE")
}
/** Internal predicate: the caller must also enforce verified identity and scan budgets. */
export function matchesExportSelection(plan: ExportSelectionPlan, row: ExportCandidate): boolean {
  assertPlan(plan); assertCandidate(row)
  if (row.isDeleted !== 0 || row.deletedAt !== null || plan.emptyIntersection) return false
  if (plan.scope.kind === "entry" && row.id !== plan.scope.id) return false
  if ((plan.from && row.entryDate < plan.from) || (plan.to && row.entryDate > plan.to)) return false
  if (plan.filters.tagIds?.some(tag => !row.tagIds.includes(tag))) return false
  if (plan.filters.hasImage !== undefined && row.hasImage !== plan.filters.hasImage) return false
  if (plan.filters.keyword) {
    const keyword = plan.filters.keyword.toLowerCase()
    if (!row.title.toLowerCase().includes(keyword) && !row.contentText.toLowerCase().includes(keyword)) return false
  }
  return true
}
const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
/** P6-only binary string tie-break; independent of locale and ordinary list order. */
export function compareExportEntries(a: ExportSelectedEntry, b: ExportSelectedEntry): number {
  return compareText(a.entryDate, b.entryDate) || (a.sortOrder > b.sortOrder ? -1 : a.sortOrder < b.sortOrder ? 1 : 0) || compareText(a.id, b.id)
}
/** Bounded retained membership only. This does NOT bound an adapter's database scan,
 * row deserialization, body size or auth lifetime, and is not a completed snapshot.
 */
export function createExportSelectionAccumulator(plan: ExportSelectionPlan) {
  assertPlan(plan)
  const selected: ExportSelectedEntry[] = [], ids = new Set<string>()
  let state: "open" | "finished" | "failed" | "cancelled" = "open"
  function ensureOpen(): void { if (state !== "open") fail("EXPORT_SELECTION_CLOSED") }
  function clear(): void { selected.length = 0; ids.clear() }
  return {
    add(row: ExportCandidate): boolean {
      ensureOpen()
      try {
        if (!matchesExportSelection(plan, row)) return false
        if (ids.has(row.id)) fail("DUPLICATE_EXPORT_ENTRY")
        if (selected.length >= 100) fail("EXPORT_ENTRY_LIMIT")
        ids.add(row.id)
        selected.push(Object.freeze({ id: row.id, entryDate: row.entryDate, sortOrder: row.sortOrder }))
        return true
      } catch (error) { state = "failed"; clear(); throw error }
    },
    finish(): readonly ExportSelectedEntry[] {
      ensureOpen(); state = "finished"
      const result = Object.freeze([...selected].sort(compareExportEntries)); clear(); return result
    },
    cancel(): void { if (state === "open") { state = "cancelled"; clear() } },
  }
}
