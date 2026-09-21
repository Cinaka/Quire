import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios"

import { clearAccessToken, getAccessToken, setAccessToken } from "./tokenStore"

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

  constructor(code: number, message: string, status?: number) {
    super(message)
    this.name = "ApiError"
    this.code = code
    this.status = status
  }
}

type RetriableConfig = InternalAxiosRequestConfig & { _retried?: boolean }

export const http: AxiosInstance = axios.create({
  // 开发走 Vite proxy、生产走 Nginx 反代，两者都是同源，所以这里只有路径。
  baseURL: import.meta.env.VITE_API_BASE_URL,
  timeout: 20_000,
  // refresh token 是 httpOnly Cookie，必须带上凭据才发得出去。
  withCredentials: true,
})

http.interceptors.request.use((config) => {
  const token = getAccessToken()
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// ---- single-flight 刷新 ----------------------------------------------------
// 同步循环会并发发请求，access 过期时它们会同时拿到 401。
// 若每个都去刷新，而 refresh 又是轮换的（每次下发新的、旧的立即作废），
// 后到的刷新必然失败，用户会被莫名踢下线。所以全局只允许有一个刷新在飞。
let refreshing: Promise<string> | null = null

async function refreshAccessToken(): Promise<string> {
  if (refreshing) return refreshing

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
      setAccessToken(token)
      return token
    } catch (e) {
      clearAccessToken()
      onUnauthorized?.()
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
      throw new ApiError(body.code, body.message || "请求失败", res.status)
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
        const token = await refreshAccessToken()
        config.headers.Authorization = `Bearer ${token}`
        return http.request(config)
      } catch {
        // 落到下面统一抛错，不再重试。
      }
    }

    const body = error.response?.data
    if (body && typeof body.code === "number") {
      throw new ApiError(body.code, body.message || error.message, status)
    }
    throw new ApiError(-1, error.message || "网络异常", status)
  },
)

/** 业务层只用这四个，永远拿到已解包的 data。 */
export async function get<T>(url: string, params?: unknown): Promise<T> {
  const res = await http.get<Envelope<T>>(url, { params })
  return res.data.data
}

export async function post<T>(url: string, body?: unknown): Promise<T> {
  const res = await http.post<Envelope<T>>(url, body)
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
