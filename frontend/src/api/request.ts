import axios, { type AxiosInstance } from "axios"

const request: AxiosInstance = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? "/api/v1",
  timeout: 15000,
})

request.interceptors.request.use((config) => {
  const token = localStorage.getItem("qingjian_access_token")
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

request.interceptors.response.use(
  (res) => {
    const body = res.data
    // 后端统一结构 { code, message, data }
    if (body && typeof body.code === "number") {
      if (body.code !== 0) return Promise.reject(new Error(body.message || "请求失败"))
      return body.data
    }
    return body
  },
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem("qingjian_access_token")
      // P2 再做跳登录，游客态不该被打断
    }
    return Promise.reject(err)
  },
)

export default request
