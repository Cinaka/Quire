import type { NotebookScope } from "@/db/notebookSessionRepo"
import type { EntryOrder } from "./types"
export interface NotebookListState {
  keyword: string; order: EntryOrder; tagIds: string[]; dateFrom: string; dateTo: string
  hasImage: boolean | undefined; filterOpen: boolean; anchor: string; book: boolean
}
let saved: { state: NotebookListState; scope: NotebookScope; editing: boolean } | null = null
// Login intent contains no entry ID. Its source scope prevents cross-account tag/filter reuse.
let login: { state: Omit<NotebookListState, "anchor">; scope: NotebookScope } | null = null
const same = (a: NotebookScope, b: NotebookScope): boolean => a.ownerUserId === b.ownerUserId && a.generation === b.generation && a.subject === b.subject && a.authGeneration === b.authGeneration
export function clearNotebookReturn(): void { saved = null }
export function validateNotebookReturnScope(scope: NotebookScope): void { if (saved && !same(saved.scope, scope)) saved = null }
export function rememberNotebookReturn(state: NotebookListState, scope: NotebookScope, editing: boolean): void {
  saved = { state: structuredClone(state), scope: { ...scope }, editing }
}
export function takeNotebookReturn(scope: NotebookScope): NotebookListState | null {
  const value = saved; saved = null
  return value && same(value.scope, scope) ? structuredClone(value.state) : null
}
export function hasNotebookEditReturn(id: string): boolean { return Boolean(saved?.editing && saved.state.anchor === id) }
export function rememberNotebookLogin(state: NotebookListState, scope: NotebookScope): void {
  const { anchor: _anchor, ...filters } = state
  login = { state: structuredClone(filters), scope: { ...scope } }
}
export function hasNotebookLogin(): boolean { return login !== null }
export function cancelNotebookLogin(): void { if (login) login.state.book = false }
export function takeNotebookLogin(scope: NotebookScope): NotebookListState | null {
  const value = login; login = null
  if (!value) return null
  const before = value.scope
  // Guest claim can retain filters; switching an owned dataset/account or restoring it cannot.
  if ((before.ownerUserId && (before.ownerUserId !== scope.ownerUserId || before.generation !== scope.generation)) ||
    (before.subject && before.subject !== scope.subject)) return null
  return { ...value.state, anchor: "" }
}
