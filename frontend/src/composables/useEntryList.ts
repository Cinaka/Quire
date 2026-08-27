import { computed, onScopeDispose, ref, watch } from "vue"

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
  const tagIds = ref<string[]>([])
  const dateFrom = ref("")
  const dateTo = ref("")
  const hasImage = ref<boolean | undefined>(undefined)
  const filterError = ref("")
  const items = ref<EntryListItem[]>([])
  const total = ref(0)
  const page = ref(1)
  const loading = ref(false)
  let seq = 0
  let debounce: number | null = null

  const hasMore = computed(() => items.value.length < total.value)

  async function fetchPage(target: number, append: boolean): Promise<void> {
    const mine = ++seq
    const from = dateFrom.value || undefined
    const to = dateTo.value || undefined

    if (from && to && from > to) {
      filterError.value = "起始日期不能晚于结束日期"
      items.value = []
      total.value = 0
      page.value = 1
      loading.value = false
      return
    }

    filterError.value = ""
    loading.value = true

    try {
      const selectedTags = [...new Set(tagIds.value)]
      const res = await entryRepo.list({
        page: target,
        pageSize: PAGE_SIZE,
        keyword: keyword.value.trim() || undefined,
        order: order.value,
        tagIds: selectedTags.length ? selectedTags : undefined,
        dateFrom: from,
        dateTo: to,
        hasImage: hasImage.value,
        onlyDeleted: options.onlyDeleted,
      })

      if (mine !== seq) return

      if (append) {
        const seen = new Set(items.value.map((entry) => entry.id))
        items.value = [...items.value, ...res.items.filter((entry) => !seen.has(entry.id))]
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

  watch(keyword, () => {
    if (debounce !== null) window.clearTimeout(debounce)
    debounce = window.setTimeout(() => {
      debounce = null
      void reload()
    }, DEBOUNCE_MS)
  })

  watch([order, dateFrom, dateTo, hasImage], () => {
    void reload()
  })

  watch(
    tagIds,
    () => {
      void reload()
    },
    { deep: true },
  )

  onScopeDispose(() => {
    seq += 1
    if (debounce !== null) window.clearTimeout(debounce)
  })

  return {
    keyword,
    order,
    tagIds,
    dateFrom,
    dateTo,
    hasImage,
    filterError,
    items,
    total,
    page,
    loading,
    hasMore,
    reload,
    loadMore,
  }
}
