import { compileExportSelection, type ExportSelectionRequest } from "./exportScope"
interface Scope { ownerUserId: string; generation: string; subject: string; authGeneration: number }
// One-use memory only. Never put entry IDs, search text, titles or permission in
// route queries/storage. An account/host generation mismatch discards the capsule.
let pending: { request: ExportSelectionRequest; scope: Scope; at: number } | undefined
export function rememberExportHandoff(request: ExportSelectionRequest, scope: Scope): void {
  pending = undefined
  const plan = compileExportSelection(request)
  pending = { request: Object.freeze({ scope: plan.scope, filters: plan.filters }), scope: { ...scope }, at: Date.now() }
}
export function validateExportHandoffScope(scope: Scope): void {
  const value = pending
  if (value && Object.keys(value.scope).some(key => value.scope[key as keyof Scope] !== scope[key as keyof Scope])) pending = undefined
}
export function takeExportHandoff(scope: Scope): ExportSelectionRequest | undefined {
  const value = pending; pending = undefined
  if (!value || Date.now() - value.at > 60000 || Date.now() < value.at || !scope.subject || scope.subject !== scope.ownerUserId ||
    Object.keys(value.scope).some(key => value.scope[key as keyof Scope] !== scope[key as keyof Scope])) return undefined
  return value.request
}
export function clearExportHandoff(): void { pending = undefined }
