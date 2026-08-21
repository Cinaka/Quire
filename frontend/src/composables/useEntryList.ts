import { computed, ref, watch } from "vue"

import { entryRepo } from "@/repo"
import type { EntryListItem, EntryOrder } from "@/shared/types"

const PAGE_SIZE = 20
const DEBOUNCE_MS = 250

export interface UseEntryListOptions {
  /** true 时只列回收站内容，供 P1-5 复用 */
  onlyDeleted?: boolean
}

export function useEntryList(options: UseEntryListOptions = {}) {
  const keyword = ref("")
  const order = ref<EntryOrder>("entryDateDesc")
  const items = ref<EntryListItem[]>([])
  const total = ref(0)
  const page = ref(1)
  const loading = ref(false)

  /**
   * 每次请求带一个自增序号。
   *
   * 搜索是防抖 + 异步的，两次请求的返回顺序不保证与发出顺序一致：
   * 输入「旅」再输入「旅行」，如果「旅」那次回来得更晚，
   * 结果就是关键词是「旅行」而列表显示的是「旅」的结果，且看不出错在哪。
   * 所以回来时先核对序号，不是最新那次就整个丢弃。
   */
  let seq = 0

  const hasMore = computed(() => items.value.length < total.value)

  async function fetchPage(target: number, append: boolean): Promise<void> {
    const mine = ++seq
    loading.value = true

    try {
      const res = await entryRepo.list({
        page: target,
        pageSize: PAGE_SIZE,
        keyword: keyword.value.trim() || undefined,
        order: order.value,
        onlyDeleted: options.onlyDeleted,
      })

      if (mine !== seq) return

      if (append) {
        // 翻页期间如果有新数据写入，切片边界会移动，可能带回重复项。
        // 按 id 去一次重，比让用户看到两条一样的日记要好。
        const seen = new Set(items.value.map((e) => e.id))
        items.value = [...items.value, ...res.items.filter((e) => !seen.has(e.id))]
      } else {
        items.value = res.items
      }

      total.value = res.total
      page.value = res.page
    } finally {
      if (mine === seq) loading.value = false
    }
  }

  function reload(): Promise<void> {
    return fetchPage(1, false)
  }

  function loadMore(): Promise<void> {
    if (loading.value || !hasMore.value) return Promise.resolve()
    return fetchPage(page.value + 1, true)
  }

  let debounce: number | null = null
  watch(keyword, () => {
    if (debounce !== null) window.clearTimeout(debounce)
    debounce = window.setTimeout(() => {
      void reload()
    }, DEBOUNCE_MS)
  })

  watch(order, () => {
    void reload()
  })

  return { keyword, order, items, total, page, loading, hasMore, reload, loadMore }
}
