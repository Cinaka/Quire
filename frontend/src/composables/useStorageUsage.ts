import { computed, ref } from "vue"

import { statsRepo } from "@/repo"
import type { LocalStats } from "@/db/statsRepo"

const WARN_RATIO = 0.8

export function useStorageUsage() {
  const stats = ref<LocalStats | null>(null)
  const usage = ref<number | null>(null)
  const quota = ref<number | null>(null)
  const loading = ref(false)

  /** 0–1，浏览器不支持 estimate() 时为 null——此时不该显示任何百分比 */
  const ratio = computed(() => {
    if (usage.value === null || !quota.value) return null
    return usage.value / quota.value
  })

  const nearLimit = computed(() => (ratio.value ?? 0) >= WARN_RATIO)

  async function refresh(): Promise<void> {
    loading.value = true
    try {
      stats.value = await statsRepo.load()

      // 三种拿不到配额的情形，全部归一为「—」：
      //   1. 非安全上下文（用局域网 IP 访问）—— navigator.storage 本身就是 undefined
      //   2. Safari 16 之前—— 没有 estimate 这个方法
      //   3. 部分隐私模式 / 未授权—— 方法在，但调用会抛
      // 前两种靠 ?. 短路拿到 undefined，第三种必须靠 catch。没有 catch 的话，
      // 异常会从 refresh() 冒到 onMounted 外，页面看上去一样是「—」但控制台多一条报错。
      //
      // 三种都不要拿 mediaBytes 冒充「已用空间」——那个数不含正文、
      // 不含索引开销，会给人一种「还很空」的错觉。
      try {
        const e = await navigator.storage?.estimate?.()
        usage.value = e?.usage ?? null
        quota.value = e?.quota ?? null
      } catch {
        usage.value = null
        quota.value = null
      }
    } finally {
      loading.value = false
    }
  }

  return { stats, usage, quota, ratio, nearLimit, loading, refresh }
}
