import { scheduleEntryId } from "./schedules"

export interface ScheduleSyncIssue {
  stage: "conversion" | "push" | "pull" | "cycle"
  sourceId: string | null
  level: "waiting" | "blocked" | "error"
  reason: string
  message: string
}
export interface ScheduleSyncIssueSummary { total: number; omitted: number; items: ScheduleSyncIssue[] }
interface Outcome { id: string; kind: string; reason: string }
interface IssueCycle {
  stopped: boolean; reason?: string
  conversions: Outcome[]
  push: { stopped?: boolean; reason?: string; items: Outcome[] } | null
  pull: Array<{ applied?: boolean; reason?: string; items: Outcome[] }>
}
const labels: Record<string, string> = {
  conversion_pending: "首次转换意图仍受保护，未在本步解除。",
  changed_locally: "请求期间本机有新修改，旧回包未覆盖它。",
  local_pending: "本机新修订仍待上传，拉取没有覆盖本机。",
  older_server_state: "已忽略早于本机已知水位的云端版本。",
  conflict_pending: "已有持久冲突候选，需要明确核对取舍。",
  stale: "双方来源修订不一致，需要明确核对。",
  dirty_conflict: "本机未上传修订与云端内容不同。",
  source_revision: "来源修订不匹配，保留原转换意图。",
  identity_conflict: "关联日记身份冲突，不能生成另一篇。",
  receipt_unknown: "首次回执无法确认，不能猜测或解除保护。",
  missing_server_base: "缺少可验证的云端基线，不能盲目上传终态。",
  revision_not_ahead: "本机修订尚未领先已知基线，需要核对。",
  terminal_source_conflict: "终态来源与基线不一致，需要核对。",
  invalid_local: "本机记录未通过校验，未自动修复或丢弃。",
  unsupported_content: "正文格式不受当前版本支持，保留原数据。",
  unauthorized: "登录请求未确认，请核对原账号与会话。",
  network: "网络请求未确认，不能据此清除待同步状态。",
  storage: "服务端存储操作未确认，请核对后端状态。",
  retry: "云端暂未确认本轮操作，仍保留本机状态。",
  ack_storage: "回包后的本机确认未完成，原记录仍受保护。",
  aborted: "本轮部分操作中断，未确认部分仍保留。",
  unconfirmed: "本阶段未确认，保留原记录与意图。",
  cursor_changed: "拉取期间游标已变化，未消费旧分页。",
  context_changed: "原账号或恢复上下文已变化，旧轮次不能继续。",
  snapshot_changed: "发送前本机快照已变化，未使用旧快照。",
  unknown: "当前版本无法解释此原因；请保留原库，不强制确认。",
}
const waits = {
  push: new Set(["conversion_pending", "changed_locally", "older_server_state"]),
  pull: new Set(["conversion_pending", "local_pending", "older_server_state"]),
}
/** Only selected scalar metadata leaves this projector. Never serialize source snapshots, errors or credentials. */
export function summarizeScheduleSyncIssues(cycle: IssueCycle): ScheduleSyncIssueSummary {
  const issues: ScheduleSyncIssue[] = []
  const priority = { blocked: 0, error: 1, waiting: 2 }
  let total = 0
  const append = (stage: ScheduleSyncIssue["stage"], raw: Outcome) => {
    if (raw.kind === "confirmed" || raw.kind === "merged") return
    let sourceId: string | null = null
    try { sourceId = scheduleEntryId(raw.id) } catch { /* Never display arbitrary IDs supplied by an unknown response. */ }
    const reason = Object.hasOwn(labels, raw.reason) ? raw.reason : "unknown"
    const waiting = raw.kind === "held" && ((stage === "push" && waits.push.has(raw.reason)) || (stage === "pull" && waits.pull.has(raw.reason)))
    issues.push({ stage, sourceId, level: waiting ? "waiting" : raw.kind === "error" ? "error" : "blocked", reason, message: labels[reason]! })
    total++
    issues.sort((a, b) => priority[a.level] - priority[b.level])
    if (issues.length > 20) issues.pop()
  }
  for (const item of cycle.conversions) append("conversion", item)
  for (const item of cycle.push?.items ?? []) append("push", item)
  for (const page of cycle.pull) {
    for (const item of page.items) append("pull", item)
    if (page.applied === false && !page.items.length) append("pull", { id: "", kind: "error", reason: page.reason ?? "unconfirmed" })
  }
  if (!issues.length && cycle.stopped) append("cycle", { id: "", kind: "error", reason: "unconfirmed" })
  return { total, omitted: total - issues.length, items: issues }
}
