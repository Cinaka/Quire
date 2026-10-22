/** Instance-local ownership: replacing/closing never revokes another reader's URL. */
export function createNotebookObjectUrls(api: Pick<typeof URL, "createObjectURL" | "revokeObjectURL"> = URL) {
  const urls = new Set<string>()
  let closed = false
  return {
    create(blob: Blob): string {
      if (closed) throw new Error("阅读图片会话已关闭")
      const url = api.createObjectURL(blob)
      urls.add(url)
      return url
    },
    release(url: string): void { if (urls.delete(url)) api.revokeObjectURL(url) },
    clear(): void { for (const url of urls) api.revokeObjectURL(url); urls.clear() },
    close(): void { this.clear(); closed = true },
  }
}
