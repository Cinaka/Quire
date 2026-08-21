/**
 * 把 Blob 存成文件。这是 P1 阶段能力适配层的第一个成员。
 *
 * 业务代码只调 saveBlob，不认识 <a download>、不认识 objectURL。
 * 将来小程序端换成 wx.getFileSystemManager().writeFile，调用方零改动。
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.rel = "noopener"

  // 不 appendChild 的话，Firefox 里 click() 不生效
  document.body.appendChild(a)
  a.click()
  a.remove()

  // 不能立刻 revoke：Safari 会在真正开始读取前就拿到一个失效的地址，
  // 表现是「下载了一个 0 字节文件」。延一秒足够，且不影响页面。
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
