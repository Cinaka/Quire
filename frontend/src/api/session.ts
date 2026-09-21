// src/api/session.ts（新建）—— 登录态的唯一判据处。页面可以直接 import 它。
import { db } from "@/db/schema"
import { getAccessToken } from "./tokenStore"

/** 有 access token 就算登录态。过期与否不在这里判，401 拦截器会自己刷。 */
export function isLoggedIn(): boolean {
  return getAccessToken() !== ""
}

/** 这个浏览器库里的数据属于谁。"" = 游客态。 */
export async function localOwnerUserId(): Promise<string> {
  const row = await db.meta.get("ownerUserId")
  return typeof row?.value === "string" ? row.value : ""
}
