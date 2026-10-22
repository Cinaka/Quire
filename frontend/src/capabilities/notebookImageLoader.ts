import type { Entry } from "@/shared/types"
import type { NotebookReadPort } from "@/repo"
import { createNotebookObjectUrls } from "./notebookObjectUrls"

export interface NotebookImageState { url: string; message: string }
/** The same request/URL lifecycle used by the Vue image, with injectable URL APIs for tests. */
export function createNotebookImageLoader(
  publish: (state: NotebookImageState) => void,
  api?: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">,
) {
  const urls = createNotebookObjectUrls(api)
  let seq = 0, closed = false
  function clear(message = "本机图片尚未读取"): void {
    ++seq
    urls.clear()
    if (!closed) publish({ url: "", message })
  }
  return {
    clear,
    async load(port: NotebookReadPort, entry: Entry, mediaId: string): Promise<void> {
      if (closed) return
      clear("读取本机图片中……")
      const mine = seq
      try {
        const image = await port.readMedia(entry, mediaId)
        if (mine !== seq || closed) return
        await port.assertCurrent()
        if (mine !== seq || closed) return
        if (image.state === "ready") publish({ url: urls.create(image.blob), message: image.thumbnailOnly ? "仅有本机缩略图" : "" })
        else publish({ url: "", message: image.state === "missing" ? "本机图片未就绪" : "本机图片格式不受支持" })
      } catch {
        if (mine === seq && !closed) publish({ url: "", message: "本机图片读取失败，请重新读取日记" })
      }
    },
    close(): void { clear(); closed = true; urls.close() },
  }
}
