// Fixed generated 2x2 calibration PNGs, not private media. No rendering/decode in this lab.
const old = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGO0Tw5lYGBgYmBgYGBgAAALqAD7BhuZCgAAAABJRU5ErkJggg=='
const newer = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNcZqHFwMDAxMDAwMDAAAANBgEM069jqgAAAABJRU5ErkJggg=='
export const MEDIA = '01900000-0000-7000-8000-000000000001'
export const THUMB = '01900000-0000-7000-8000-000000000002'
export const MISSING = '01900000-0000-7000-8000-000000000003'
export const UNUSED = '01900000-0000-7000-8000-000000000004'
export const png = version => new Blob([Uint8Array.from(atob(version === 'old' ? old : newer), c => c.charCodeAt(0))], { type: 'image/png' })
export const content = (text, images = []) => ({ schemaVersion: 1, doc: { type: 'doc', content: [
  { type: 'paragraph', content: [{ type: 'text', text }] },
  ...images.map(id => ({ type: 'image', attrs: { src: `local://media/${id}` } })),
] } })
export function entry(n, patch = {}) {
  return { id: `fixed-${String(n).padStart(2, '0')}`, entryDate: '2026-10-21', sortOrder: n,
    title: `固定第${n}简`, content: content(`固定正文${n}`), contentText: `固定正文${n}`,
    tagIds: [], mood: null, weather: null, fromScheduleId: 'PRIVATE_PROVENANCE_MUST_NOT_ESCAPE',
    createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T00:00:00Z', clientUpdatedAt: '2026-10-21T00:00:00Z',
    serverUpdatedAt: '', dirty: 1, deletedAt: null, isDeleted: 0, ...patch }
}
export function image(id, blob = png('old'), patch = {}) {
  return { id, entryId: 'fixed-01', blob, thumbBlob: null, mime: 'image/png', width: 2, height: 2, size: blob.size,
    sortOrder: 0, remoteUrl: 'https://never-request.invalid/private-cloud', thumbRemoteUrl: '',
    createdAt: '2026-10-21T00:00:00Z', dirty: 1, ...patch }
}
export const versionEntry = version => entry(1, { title: `version-${version}`, tagIds: ['fixed-tag'], content: content(`BODY_${version}`, [MEDIA]), contentText: `BODY_${version}` })
export const versionTag = version => ({ id: 'fixed-tag', name: `TAG_${version}`, color: null, createdAt: '2026-10-21T00:00:00Z', dirty: 1 })
