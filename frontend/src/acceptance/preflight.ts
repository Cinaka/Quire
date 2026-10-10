import { ACCEPTANCE_DB_NAME, ACCEPTANCE_MARKER, isAcceptanceMarker, type AcceptanceSpec } from "./guard"

/** 在导入Dexie/业务模块前执行。无version的原生只读检查；不清库，不升级未知数据。 */
export async function preflightAcceptanceDb(factory: IDBFactory, spec: AcceptanceSpec): Promise<void> {
  if (typeof factory.databases !== "function") throw new Error("当前浏览器不支持只读数据库枚举，已拒绝进入；请使用支持的浏览器")
  const databases = await factory.databases()
  if (!databases.some(row => row.name === ACCEPTANCE_DB_NAME)) return
  await new Promise<void>((resolve, reject) => {
    const request = factory.open(ACCEPTANCE_DB_NAME)
    let failed = false
    const fail = (message: string): void => { failed = true; reject(new Error(message)) }
    request.onupgradeneeded = () => { request.transaction?.abort(); fail("验收库在检查期间变化，已阻止原生创建/升级") }
    request.onerror = () => fail("无法只读确认验收库，未重试升级或删除")
    request.onblocked = () => fail("验收库被其他页面占用，请先关闭该验收页面")
    request.onsuccess = () => {
      const database = request.result
      if (failed) { database.close(); return }
      // Dexie version(3)对应原生IndexedDB version 30。
      if (database.version !== 30 || !database.objectStoreNames.contains("meta")) { database.close(); fail("已有同名库不是本批v3验收库，未升级或覆盖"); return }
      try {
        const transaction = database.transaction("meta", "readonly")
        const marker = transaction.objectStore("meta").get(ACCEPTANCE_MARKER)
        let valid = false
        marker.onsuccess = () => { valid = isAcceptanceMarker(marker.result?.value, spec) }
        transaction.oncomplete = () => { database.close(); if (valid) resolve(); else fail("已有同名库未登记本次隔离origin，拒绝接管") }
        transaction.onabort = () => { database.close(); fail("验收库只读检查失败，未修改数据") }
        transaction.onerror = () => { database.close(); fail("验收库只读检查失败，未修改数据") }
      } catch { database.close(); fail("验收库无法创建只读事务，未修改或升级") }
    }
  })
}
