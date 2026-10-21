/**
 * access token 的唯一存取点。
 *
 * key 只有 quire_access_token 一个。旧名 qingjian_access_token 已在 P2 彻底删除，
 * 不做兼容读取：P1 阶段从未登录、从未写过这个 key，localStorage 里不存在旧值。
 */
export const ACCESS_TOKEN_KEY = "quire_access_token"

let cached: string | null = null
let generation = 0
export function tokenGeneration(): number { return generation }
export function invalidateTokenContext(): void { generation += 1 }

export function getAccessToken(): string {
  if (cached !== null) return cached
  cached = localStorage.getItem(ACCESS_TOKEN_KEY) ?? ""
  return cached
}

export function accessTokenSubject(token = getAccessToken()): string {
  const encoded = token.split(".")[1]
  if (!encoded) return ""
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/")
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")
    const payload = JSON.parse(atob(padded)) as { sub?: unknown }
    return typeof payload.sub === "string" ? payload.sub : ""
  } catch {
    return ""
  }
}

export function setAccessToken(token: string): void {
  if (!token || accessTokenSubject(token) !== accessTokenSubject(getAccessToken())) generation += 1
  cached = token
  if (token) localStorage.setItem(ACCESS_TOKEN_KEY, token)
  else localStorage.removeItem(ACCESS_TOKEN_KEY)
}

export function clearAccessToken(): void {
  setAccessToken("")
}

window.addEventListener("storage", (event) => {
  if (event.key === ACCESS_TOKEN_KEY) {
    const next = event.newValue ?? ""
    if (!next || accessTokenSubject(next) !== accessTokenSubject(getAccessToken())) generation += 1
    cached = next
  }
})

/** refresh token 不在这里——它是 httpOnly Cookie，JS 读不到也不该读。 */
