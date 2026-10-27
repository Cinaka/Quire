import { uuidToHex } from "@/shared/uuidHex"
import type { AxiosRequestConfig } from "axios"

import { ApiError, http } from "./request"
import { accessTokenSubject, tokenGeneration } from "./tokenStore"

const MAX_BYTES = 10 * 1024 * 1024
const MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"])
export interface MediaLease { ownerUserId: string; tokenGeneration: number }

export async function readPrivateMedia(
  id: string, variant: "original" | "thumbnail", lease: MediaLease,
): Promise<Blob> {
  id = uuidToHex(id, true)
  const current = () => accessTokenSubject() === lease.ownerUserId &&
    tokenGeneration() === lease.tokenGeneration
  if (!["original", "thumbnail"].includes(variant) || !lease.ownerUserId || !current()) {
    throw new ApiError(-1, "图片读取身份或范围已失效")
  }
  const controller = new AbortController()
  const options: AxiosRequestConfig & { _syncOwner: string; _tokenGeneration: number } = {
    responseType: "blob", signal: controller.signal,
    _syncOwner: lease.ownerUserId, _tokenGeneration: lease.tokenGeneration,
    onDownloadProgress: progress => {
      if (progress.loaded > MAX_BYTES || !current()) controller.abort()
    },
  }
  const response = await http.get<Blob>(`/media/${id}/${variant}`, options)
  if (!current() || response.status !== 200 || !(response.data instanceof Blob) ||
      response.data.size === 0 || response.data.size > MAX_BYTES ||
      !MIME.has(response.data.type.toLowerCase())) {
    throw new ApiError(-1, "图片响应无效或旧会话已失效")
  }
  return response.data
}
