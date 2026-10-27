import { v7 as uuidv7 } from "uuid"

import { uuidToHex } from "./uuidHex"

/**
 * 主键由前端生成，不向服务器申请。
 * 用 v7 而不是 v4：v7 前 48 位是毫秒时间戳且大端序，
 * 32 位小写 hex 保留原始字节序；MySQL CHAR(32)/ascii_bin 按该顺序比较。
 */
export function newId(): string {
  return uuidToHex(uuidv7(), true)
}
