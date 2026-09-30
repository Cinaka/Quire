import { db } from "@/db/schema"

import { clearCheckinCache, currentCheckinCacheOwner } from "./checkinCache"
import { del, get, post } from "./request"
import { clearAccessToken, getAccessToken, setAccessToken } from "./tokenStore"

const DEFAULT_TIMEZONE = "Asia/Shanghai"
const SESSION_EVENT_KEY = "quire_session_event"

export interface SessionUser {
  id: string
  email: string | null
  nickname: string | null
  timezone: string
}

export interface DeviceSession {
  id: string
  createdAt: string
  expiresAt: string
  current: boolean
}

interface AuthResponse {
  user: SessionUser
  access_token: string
  expires_in: number
}

interface RefreshResponse {
  access_token: string
  expires_in: number
}

interface LogoutEvent {
  type: "logout"
  userId: string
  emittedAt: number
}

function detectedTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone?.trim() || DEFAULT_TIMEZONE
  } catch {
    return DEFAULT_TIMEZONE
  }
}

function broadcastLogout(userId: string): void {
  try {
    localStorage.setItem(
      SESSION_EVENT_KEY,
      JSON.stringify({ type: "logout", userId, emittedAt: Date.now() } satisfies LogoutEvent),
    )
    localStorage.removeItem(SESSION_EVENT_KEY)
  } catch {
    // 跨标签页通知失败不影响当前标签页退出。
  }
}

export function onRemoteLogout(listener: () => void): () => void {
  const handleStorage = (event: StorageEvent): void => {
    if (event.key !== SESSION_EVENT_KEY || !event.newValue) return
    try {
      const message = JSON.parse(event.newValue) as Partial<LogoutEvent>
      if (message.type !== "logout" || typeof message.userId !== "string") return
      clearCheckinCache(message.userId)
      clearAccessToken()
      listener()
    } catch {
      // 忽略格式异常或其他应用写入的 storage 事件。
    }
  }
  window.addEventListener("storage", handleStorage)
  return () => window.removeEventListener("storage", handleStorage)
}

export function isLoggedIn(): boolean {
  return getAccessToken() !== ""
}

export async function localOwnerUserId(): Promise<string> {
  const row = await db.meta.get("ownerUserId")
  return typeof row?.value === "string" ? row.value : ""
}

export async function login(email: string, password: string): Promise<SessionUser> {
  const data = await post<AuthResponse>("/auth/login", { email, password })
  setAccessToken(data.access_token)
  return data.user
}

export async function register(
  email: string,
  password: string,
  timezone = detectedTimezone(),
): Promise<SessionUser> {
  const data = await post<AuthResponse>("/auth/register", { email, password, timezone })
  setAccessToken(data.access_token)
  return data.user
}

export async function refreshSession(): Promise<string> {
  const data = await post<RefreshResponse>("/auth/refresh")
  setAccessToken(data.access_token)
  return data.access_token
}

export async function logout(): Promise<void> {
  const checkinCacheOwner = currentCheckinCacheOwner()
  try {
    await post<null>("/auth/logout")
  } finally {
    clearCheckinCache(checkinCacheOwner)
    clearAccessToken()
    broadcastLogout(checkinCacheOwner)
  }
}

export async function listDeviceSessions(): Promise<DeviceSession[]> {
  return get<DeviceSession[]>("/auth/sessions")
}

export async function revokeOtherSessions(): Promise<number> {
  const data = await post<{ revoked: number }>("/auth/sessions/revoke-others")
  return data.revoked
}

export async function revokeDeviceSession(id: string): Promise<void> {
  await del<null>(`/auth/sessions/${id}`)
}
