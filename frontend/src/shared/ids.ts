import { v7 as uuidv7 } from "uuid"

/**
 * 主键由前端生成，不向服务器申请。
 * 用 v7 而不是 v4：v7 前 48 位是毫秒时间戳且大端序，
 * 存进 MySQL 的 BINARY(16) 后天然按时间递增，插入不会造成 B+ 树页分裂。
 */
export function newId(): string {
  return uuidv7()
}
