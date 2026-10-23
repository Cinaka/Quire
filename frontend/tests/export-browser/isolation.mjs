/** Test tooling only. Production builds never load this resolver. */
export const PREFIX = 'quire-p6-snapshotcheck-'
export function testOrigin(location) {
  return location.protocol === 'http:' && location.hostname === '127.0.0.1' && location.port === '5185'
}
export function replacement(source, importer, root) {
  const base = root.replace(/\\/g, '/').replace(/\/$/, '')
  if (importer?.replace(/\\/g, '/') !== `${base}/src/db/exportSnapshotRepo.ts`) return
  const specifier = source.replace(/\\/g, '/')
  if (specifier === 'dexie') return `${base}/tests/export-browser/dexie-probe.mjs`
  if (['./schema', './scheduleHostContext', '@/api/tokenStore', `${base}/src/api/tokenStore`, `${base}/src/api/tokenStore.ts`].includes(specifier)) return `${base}/tests/export-browser/store.mjs`
}
export function installDatabaseGuard(factory, name, opened) {
  if (!new RegExp(`^${PREFIX}[0-9a-f-]{36}$`).test(name)) throw Error('非法测试库名')
  const open = factory.open, remove = factory.deleteDatabase
  const guardedOpen = function (candidate, version) {
    if (candidate !== name) throw Error('拒绝打开非本次随机测试库')
    opened.push(candidate)
    return version === undefined ? open.call(factory, candidate) : open.call(factory, candidate, version)
  }
  const guardedDelete = () => { throw Error('测试期间禁止删除数据库') }
  try {
    factory.open = guardedOpen; factory.deleteDatabase = guardedDelete
    if (factory.open !== guardedOpen || factory.deleteDatabase !== guardedDelete) throw Error('浏览器不支持安装测试库守卫；未启动')
  } catch (error) {
    try { factory.open = open } catch { /* remain fail-closed until reload */ }
    try { factory.deleteDatabase = remove } catch { /* remain fail-closed until reload */ }
    throw error
  }
  return () => { factory.open = open; factory.deleteDatabase = remove }
}
