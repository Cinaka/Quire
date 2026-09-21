import { db } from "@/db/schema"

import { del, get, post } from "./request"
import { clearAccessToken, getAccessToken, setAccessToken } from "./tokenStore"

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
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
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
  try {
    await post<null>("/auth/logout")
  } finally {
    clearAccessToken()
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
