export interface ResizeOptions {
  /** 长边上限（CSS 像素）。短边按原比例缩 */
  maxEdge: number
  quality?: number
  mime?: string
}

/**
 * 把一张图缩到指定长边以内。
 *
 * 返回 null 有两种含义，调用方处理方式一样——「用原图就行」：
 *   1. 原图已经比目标小（不放大：放大只会让文件变大、画质不变）
 *   2. 解码失败（SVG / 动图 / 损坏文件 / 浏览器不支持）
 *
 * 注意它 throw 不出来。缩略图缺失只应降级成用原图，
 * 绝不能让「贴图」这个动作本身失败。
 */
export async function resizeToBlob(
  src: Blob,
  { maxEdge, quality = 0.8, mime = "image/webp" }: ResizeOptions,
): Promise<Blob | null> {
  if (typeof createImageBitmap !== "function") return null

  let bmp: ImageBitmap
  try {
    // imageOrientation 必须显式传。手机拍的竖图靠 EXIF orientation 记旋转，
    // 不传这个选项时部分浏览器会按未旋转的像素解码，
    // 结果是缩略图躺着、原图站着。
    bmp = await createImageBitmap(src, { imageOrientation: "from-image" })
  } catch {
    return null
  }

  try {
    const longEdge = Math.max(bmp.width, bmp.height)
    if (longEdge <= maxEdge) return null

    const scale = maxEdge / longEdge
    const w = Math.max(1, Math.round(bmp.width * scale))
    const h = Math.max(1, Math.round(bmp.height * scale))

    // OffscreenCanvas 不碰 document，优先走它
    if (typeof OffscreenCanvas === "function") {
      const canvas = new OffscreenCanvas(w, h)
      const ctx = canvas.getContext("2d")
      if (!ctx) return null
      ctx.imageSmoothingQuality = "high"
      ctx.drawImage(bmp, 0, 0, w, h)
      return await canvas.convertToBlob({ type: mime, quality })
    }

    // 回退：真实 DOM canvas。只有这一处碰 document，所以整个文件得待在 capabilities/
    const el = document.createElement("canvas")
    el.width = w
    el.height = h
    const ctx = el.getContext("2d")
    if (!ctx) return null
    ctx.imageSmoothingQuality = "high"
    ctx.drawImage(bmp, 0, 0, w, h)

    return await new Promise<Blob | null>((resolve) => {
      el.toBlob((b) => resolve(b), mime, quality)
    })
  } catch {
    return null
  } finally {
    bmp.close()
  }
}
