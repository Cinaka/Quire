/**
 * access token 的唯一存取点。
 *
 * key 只有 quire_access_token 一个。旧名 qingjian_access_token 已在 P2 彻底删除，
 * 不做兼容读取：P1 阶段从未登录、从未写过这个 key，localStorage 里不存在旧值。
 */
const ACCESS_TOKEN_KEY = "quire_access_token"

let cached: string | null = null

export function getAccessToken(): string {
  if (cached !== null) return cached
  cached = localStorage.getItem(ACCESS_TOKEN_KEY) ?? ""
  return cached
}

export function setAccessToken(token: string): void {
  cached = token
  if (token) localStorage.setItem(ACCESS_TOKEN_KEY, token)
  else localStorage.removeItem(ACCESS_TOKEN_KEY)
}

export function clearAccessToken(): void {
  setAccessToken("")
}

/** refresh token 不在这里——它是 httpOnly Cookie，JS 读不到也不该读。 */
