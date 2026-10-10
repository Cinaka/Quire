import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios"

import { accessTokenSubject, clearAccessToken, getAccessToken, setAccessToken, tokenGeneration } from "./tokenStore"

/** 后端统一响应体。code === 0 才是成功。 */
export interface Envelope<T> {
  code: number
  message: string
  data: T
}

/**
 * 不能用构造函数参数属性（public code: number）。
 *
 * Vite 7 的 Vue-TS 模板默认开了 erasableSyntaxOnly，它只允许「抹掉类型就等价」
 * 的语法。参数属性、enum、namespace 都会生成运行时代码，因此一律报 TS1294。
 * 字段显式声明 + 构造函数里手写赋值，行为完全一致。
 */
export class ApiError extends Error {
  readonly code: number
  readonly status?: number
  /** Only explicitly pinned P4 HTTP 409 requests retain candidate data in memory. */
  readonly data?: unknown

  constructor(code: number, message: string, status?: number, data?: unknown) {
    super(message)
    this.name = "ApiError"
    this.code = code
    this.status = status
    this.data = data
  }
}

type RetriableConfig = InternalAxiosRequestConfig & { _retried?: boolean; _syncOwner?: string; _tokenGeneration?: number; _retainScheduleConflict?: boolean }

export const http: AxiosInstance = axios.create({
  // 开发走 Vite proxy、生产走 Nginx 反代，两者都是同源，所以这里只有路径。
  baseURL: import.meta.env.VITE_API_BASE_URL,
  timeout: 20_000,
  // refresh token 是 httpOnly Cookie，必须带上凭据才发得出去。
  withCredentials: true,
})

http.interceptors.request.use((config) => {
  const guarded = config as RetriableConfig
  if (guarded._syncOwner && (accessTokenSubject() !== guarded._syncOwner ||
      (guarded._tokenGeneration !== undefined && guarded._tokenGeneration !== tokenGeneration()))) {
    throw new ApiError(-1, "同步账号已变化，请重新发起同步")
  }
  const token = getAccessToken()
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// ---- single-flight 刷新 ----------------------------------------------------
// 同步循环会并发发请求，access 过期时它们会同时拿到 401。
// 若每个都去刷新，而 refresh 又是轮换的（每次下发新的、旧的立即作废），
// 后到的刷新必然失败，用户会被莫名踢下线。所以全局只允许有一个刷新在飞。
let refreshing: Promise<string> | null = null
let refreshingGeneration = -1

async function refreshAccessToken(): Promise<string> {
  if (refreshing) {
    if (refreshingGeneration === tokenGeneration()) return refreshing
    await refreshing.catch(() => undefined)
    return refreshAccessToken()
  }

  const subject = accessTokenSubject()
  const generation = tokenGeneration()
  refreshingGeneration = generation
  refreshing = (async () => {
    try {
      // 用裸 axios，绕开本实例的拦截器，避免刷新自身 401 时递归。
      const res = await axios.post<Envelope<{ access_token: string }>>(
        "/auth/refresh",
        null,
        { baseURL: import.meta.env.VITE_API_BASE_URL, withCredentials: true },
      )
      const token = res.data?.data?.access_token ?? ""
      if (!token) throw new ApiError(-1, "refresh 未返回 access_token", 401)
      if (tokenGeneration() !== generation || accessTokenSubject() !== subject ||
        (subject && accessTokenSubject(token) !== subject)) {
        throw new ApiError(-1, "旧刷新响应已失效", 401)
      }
      setAccessToken(token)
      return token
    } catch (e) {
      if (tokenGeneration() === generation && accessTokenSubject() === subject) {
        clearAccessToken()
        onUnauthorized?.()
      }
      throw e
    } finally {
      refreshing = null
    }
  })()

  return refreshing
}

/** 刷新彻底失败时的回调，由路由层注入（跳登录页）。此处不 import router。 */
let onUnauthorized: (() => void) | null = null

export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn
}

http.interceptors.response.use(
  (res: AxiosResponse<Envelope<unknown>>) => {
    const body = res.data
    // 有 code 字段就按统一响应体校验；文件流等无 envelope 的响应原样放过。
    if (body && typeof body.code === "number" && body.code !== 0) {
      throw new ApiError(body.code, body.message || "请求失败", res.status,
        (res.config as RetriableConfig)?._retainScheduleConflict && res.status === 409 && body.code === 409 ? body.data : undefined)
    }
    return res
  },
  async (error: AxiosError<Envelope<unknown>>) => {
    const config = error.config as RetriableConfig | undefined
    const status = error.response?.status

    // 401 且未重放过 → 刷新一次，然后原样重放。
    // 刷新端点自身的 401 不进这里（它用的是裸 axios）。
    if (status === 401 && config && !config._retried) {
      config._retried = true
      try {
        if (config._syncOwner && (accessTokenSubject() !== config._syncOwner ||
            config._tokenGeneration !== tokenGeneration())) {
          throw new ApiError(-1, "旧同步会话已失效，禁止刷新或重放", 401)
        }
        const token = await refreshAccessToken()
        if (config._syncOwner && (accessTokenSubject(token) !== config._syncOwner ||
            config._tokenGeneration !== tokenGeneration())) {
          throw new ApiError(-1, "同步账号已变化，禁止重放旧请求", 401)
        }
        config.headers.Authorization = `Bearer ${token}`
        return http.request(config)
      } catch {
        // 落到下面统一抛错，不再重试。
      }
    }

    const body = error.response?.data
    if (body && typeof body.code === "number") {
      throw new ApiError(body.code, body.message || error.message, status,
        config?._retainScheduleConflict && status === 409 && body.code === 409 ? body.data : undefined)
    }
    throw new ApiError(-1, error.message || "网络异常", status)
  },
)

/** 业务层只用这四个，永远拿到已解包的 data。 */
export async function get<T>(url: string, params?: unknown, syncOwner?: string): Promise<T> {
  const res = await http.get<Envelope<T>>(url, { params, ...syncRequestOptions(syncOwner) })
  return res.data.data
}

export async function post<T>(url: string, body?: unknown, syncOwner?: string): Promise<T> {
  const res = await http.post<Envelope<T>>(url, body, syncRequestOptions(syncOwner))
  return res.data.data
}

export async function put<T>(url: string, body?: unknown): Promise<T> {
  const res = await http.put<Envelope<T>>(url, body)
  return res.data.data
}

export async function del<T>(url: string, body?: unknown): Promise<T> {
  const res = await http.delete<Envelope<T>>(url, { data: body })
  return res.data.data
}

function syncRequestOptions(syncOwner?: string): AxiosRequestConfig & { _syncOwner?: string; _tokenGeneration?: number } {
  return syncOwner ? { _syncOwner: syncOwner, _tokenGeneration: tokenGeneration() } : {}
}


/** Internal P4-only POST: pin the supplied generation, never recapture it at send time. */
export async function postPinnedSchedule<T>(
  url: string, body: unknown, lease: { ownerUserId: string; tokenGeneration: number },
): Promise<T> {
  const id = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
  if (!new RegExp(`^/schedules/(?:sync/push|${id}/convert)$`).test(url) ||
      !lease.ownerUserId || !Number.isSafeInteger(lease.tokenGeneration) || lease.tokenGeneration < 0) {
    throw new ApiError(-1, "日程请求路径或登录租约无效")
  }
  const options: AxiosRequestConfig & { _syncOwner: string; _tokenGeneration: number; _retainScheduleConflict: boolean } = {
    _syncOwner: lease.ownerUserId, _tokenGeneration: lease.tokenGeneration, _retainScheduleConflict: true,
  }
  const res = await http.post<Envelope<T>>(url, body, options)
  if (accessTokenSubject() !== lease.ownerUserId || tokenGeneration() !== lease.tokenGeneration) {
    throw new ApiError(-1, "旧日程响应已失效")
  }
  return res.data.data
}

/** P4 changes GET pins the caller's original token generation, just like its POST. */
export async function getPinnedScheduleChanges<T>(
  params: unknown, lease: { ownerUserId: string; tokenGeneration: number },
): Promise<T> {
  if (!lease.ownerUserId || !Number.isSafeInteger(lease.tokenGeneration) || lease.tokenGeneration < 0) {
    throw new ApiError(-1, "日程拉取登录租约无效")
  }
  const options: AxiosRequestConfig & { _syncOwner: string; _tokenGeneration: number } = {
    params, _syncOwner: lease.ownerUserId, _tokenGeneration: lease.tokenGeneration,
  }
  const res = await http.get<Envelope<T>>("/schedules/sync/changes", options)
  if (accessTokenSubject() !== lease.ownerUserId || tokenGeneration() !== lease.tokenGeneration) {
    throw new ApiError(-1, "旧日程拉取响应已失效")
  }
  return res.data.data
}

/** Conflict review GET accepts a stable source ID only and never recaptures a new login lease. */
export async function getPinnedScheduleDetail<T>(
  id: string, lease: { ownerUserId: string; tokenGeneration: number },
): Promise<T> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) ||
      !lease.ownerUserId || !Number.isSafeInteger(lease.tokenGeneration) || lease.tokenGeneration < 0) {
    throw new ApiError(-1, "日程核对ID或登录租约无效")
  }
  const options: AxiosRequestConfig & { _syncOwner: string; _tokenGeneration: number } = {
    _syncOwner: lease.ownerUserId, _tokenGeneration: lease.tokenGeneration,
  }
  const res = await http.get<Envelope<T>>(`/schedules/${id}`, options)
  if (accessTokenSubject() !== lease.ownerUserId || tokenGeneration() !== lease.tokenGeneration) {
    throw new ApiError(-1, "旧日程核对响应已失效")
  }
  return res.data.data
}
