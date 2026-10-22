<template>
  <div
    class="list-page mx-auto w-full max-w-2xl px-4 py-4"
    :style="pullStyle"
    :class="{ 'book-page': book }"
    @touchstart="onTouchStart"
    @touchmove="onTouchMove"
    @touchend="onTouchEnd"
    @touchcancel="onTouchCancel"
  >
    <div class="pull-indicator" :class="{ visible: distance > 0 || refreshing }">
      {{ refreshing ? "重读简册中……" : ready ? "松手重读" : "下拉重读" }}
    </div>

    <header class="head">
      <button type="button" class="plain" @click="router.push('/')">今简</button>
      <h1 class="page-title">成编</h1>
      <button type="button" class="plain accent" @click="router.push('/entry/new')">刻一简</button>
    </header>

    <div class="view-switch" aria-label="简册视图">
      <button type="button" class="view-button" :class="{ active: !book }" :aria-pressed="!book" :disabled="restoring" @click="switchView(false)">列表视图</button>
      <button type="button" class="view-button" :class="{ active: book }" :aria-pressed="book" :disabled="verifying || restoring" @click="switchView(true)">{{ verifying ? "核验中…" : "日记本视图" }}</button>
    </div>

    <p v-if="notice" class="reader-notice" role="status">{{ notice }}</p>
    <div v-if="gateError" class="reader-notice" role="alert">
      <p>{{ gateError }}</p>
      <button type="button" class="plain accent" @click="loginForBook">登录…</button>
      <button type="button" class="plain accent" :disabled="verifying" @click="switchView(true)">联网重新核验</button>
    </div>
    <p v-if="queryError || filterError" class="reader-notice" role="alert">{{ queryError || filterError }} <button type="button" class="plain accent" @click="reload">重试检简</button></p>
    <p v-if="protectedTarget" class="reader-notice">此简由预简转成，请在既有受保护入口核对并编辑。<button type="button" class="plain accent" @click="router.push('/schedules')">前往预简 / 待刻</button></p>
    <input
      v-model="keyword"
      class="search"
      type="search"
      placeholder="搜标题与正文"
      enterkeyhint="search"
    />

    <div class="filter-heading">
      <button type="button" class="plain accent" :aria-expanded="filterOpen" @click="filterOpen = !filterOpen">
        {{ filterOpen ? "收起筛选" : "展开筛选" }}
      </button>
      <span v-if="loading && items.length" class="count">检简中……</span>
    </div>

    <section v-if="filterOpen" class="filters" aria-label="筛选简册">
      <div class="filter-row">
        <span class="filter-label">标签</span>
        <div class="filter-options">
          <button
            v-for="tag in tags"
            :key="tag.id"
            type="button"
            class="chip"
            :class="{ on: tagIds.includes(tag.id) }"
            :aria-pressed="tagIds.includes(tag.id)"
            @click="toggleTag(tag.id)"
          >
            {{ tag.name }}
          </button>
          <span v-if="!tags.length" class="count">暂无标签</span>
        </div>
        <small>多选时同时包含</small>
      </div>

      <div class="filter-row date-range">
        <label>起始 <input v-model="dateFrom" type="date" /></label>
        <label>结束 <input v-model="dateTo" type="date" /></label>
      </div>

      <div class="filter-row">
        <span class="filter-label">图片</span>
        <div class="filter-options">
          <button type="button" class="chip" :class="{ on: hasImage === undefined }" @click="hasImage = undefined">全部</button>
          <button type="button" class="chip" :class="{ on: hasImage === true }" @click="hasImage = true">有图</button>
          <button type="button" class="chip" :class="{ on: hasImage === false }" @click="hasImage = false">无图</button>
        </div>
      </div>

      <div class="filter-actions">
        <button type="button" class="plain" @click="clearFilters">清除筛选</button>
      </div>

      <p v-if="filterError || tagError" class="filter-error" role="alert">
        {{ filterError || tagError }}
      </p>
    </section>

    <div class="bar">
      <div class="orders">
        <button
          v-for="option in ORDERS"
          :key="option.value"
          type="button"
          class="chip"
          :class="{ on: order === option.value }"
          @click="order = option.value"
        >
          {{ option.label }}
        </button>
      </div>
      <span class="count">共 {{ total }} 简</span>
    </div>

    <NotebookBook v-if="book && readPort && !restoring && !queryError && !filterError && items.length"
      :port="readPort" :ids="entryIds" :anchor="anchor" :width="width" :total="total"
      :busy="loading || moving" :has-more="hasMore" :tag-names="tagNameById" @move="move" @edit="editFromBook" @refresh="refreshUnavailable" />
    <div v-else-if="(loading || restoring) && !items.length && !filterError && !queryError" class="skeleton-list" aria-label="检简中">
      <div v-for="index in 5" :key="index" class="skeleton-row">
        <span class="skeleton-thumb" />
        <span class="skeleton-copy"><i /><i /></span>
      </div>
    </div>

    <template v-else-if="!book && items.length">
      <section v-for="group in groups" :key="group.key" class="group">
        <h2 class="group-title" :class="{ static: order === 'updatedAtDesc' }">{{ group.label }}</h2>
        <ul class="list">
          <li v-for="entry in group.items" :key="entry.id">
            <button type="button" class="row" @click="open(entry.id)">
              <EntryThumbnail
                v-if="coverByEntry[entry.id]"
                :media-id="coverByEntry[entry.id] ?? null"
              />
              <span class="row-copy">
                <span class="row-head">
                  <span class="row-title">{{ entry.title.trim() || "无题" }}</span>
                  <span class="row-tail">
                    <!-- 图片数量徽标。图标无文本，屏读靠 aria-label 说全 -->
                    <span
                      v-if="imageCountByEntry[entry.id]"
                      class="img-badge"
                      :aria-label="`${imageCountByEntry[entry.id]} 张图片`"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                        <rect x="3" y="5" width="18" height="14" rx="2" />
                        <circle cx="8.5" cy="10" r="1.5" />
                        <path d="M21 16l-5-5-9 8" />
                      </svg>
                      {{ imageCountByEntry[entry.id] }}
                    </span>
                    <span class="row-day">{{ dayLabel(entry.entryDate) }}</span>
                  </span>
                </span>

                <!-- 有真文本时仍走 highlightParts，搜索命中必须能高亮；
                     整篇只有图时才用 entryExcerpt 的张数兜底，并弱化颜色。 -->
                <span class="row-snippet" :class="{ faint: !hasText(entry) }">
                  <template v-if="hasText(entry)">
                    <span v-for="(part, index) in snippet(entry)" :key="index" :class="{ hit: part.hit }">{{ part.text }}</span>
                  </template>
                  <template v-else>{{ fallbackExcerpt(entry) }}</template>
                </span>

                <span v-if="entry.mood || entry.weather || entry.tagIds.length" class="row-meta">
                  <span v-if="entry.mood">{{ entry.mood }}</span>
                  <span v-if="entry.weather">{{ entry.weather }}</span>
                  <span v-for="id in entry.tagIds" :key="id" class="tag-name">
                    {{ tagNameById[id] ?? "" }}
                  </span>
                </span>
              </span>
            </button>
          </li>
        </ul>
      </section>

      <button v-if="hasMore" type="button" class="more" :disabled="loading" @click="loadMore">
        {{ loading ? "检简中……" : "再展一卷" }}
      </button>
      <p v-else-if="page > 1" class="end">已至卷末</p>
    </template>

    <p v-else-if="!queryError && !filterError && !restoring" class="empty">
      {{ hasFilters ? "筛选之下，未见合意之简。" : "简册尚空，今日宜落笔。" }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, shallowRef, watch } from "vue"
import { useRoute, useRouter } from "vue-router"

import EntryThumbnail from "@/components/EntryThumbnail.vue"
import { useEntryList } from "@/composables/useEntryList"
import { usePullToRefresh } from "@/composables/usePullToRefresh"
import { mediaRepo, tagRepo, entryRepo, captureNotebookScope, createVerifiedNotebookReadPort, type NotebookReadPort } from "@/repo"
import { notebookTargetIndex } from "@/shared/notebookNavigation"
import { canOpenScheduleDiaryContent } from "@/shared/scheduleEditorContent"
import { rememberNotebookReturn, takeNotebookReturn, rememberNotebookLogin, takeNotebookLogin, type NotebookListState } from "@/shared/notebookReturn"
const NotebookBook = defineAsyncComponent(() => import("@/components/notebook/NotebookBook.vue"))
import { entryExcerpt } from "@/shared/entryMeta"
import { highlightParts, type TextPart } from "@/shared/text"
import type { EntryListItem, EntryOrder, Tag } from "@/shared/types"

const route = useRoute()
const router = useRouter()

const ORDERS: Array<{ value: EntryOrder; label: string }> = [
  { value: "entryDateDesc", label: "新在前" },
  { value: "entryDateAsc", label: "旧在前" },
  { value: "updatedAtDesc", label: "近改动" },
]

const {
  keyword,
  order,
  tagIds,
  dateFrom,
  dateTo,
  hasImage,
  filterError,
  queryError,
  revision,
  items,
  total,
  page,
  loading,
  hasMore,
  reload,
  loadMore,
} = useEntryList()

const book = ref(false), verifying = ref(false), gateError = ref(""), notice = ref("")
const readPort = shallowRef<NotebookReadPort | null>(null)
const anchor = ref(""), width = ref(window.innerWidth), moving = ref(false), protectedTarget = ref(false)
const restoring = ref(true)
const entryIds = computed(() => items.value.map(entry => entry.id))
let gateSeq = 0, disposed = false, initialized = false, listScopeKey = "", missingRefreshKey = ""
function resize(): void { width.value = window.innerWidth }
function state(id = anchor.value): NotebookListState {
  return { keyword: keyword.value, order: order.value, tagIds: [...tagIds.value], dateFrom: dateFrom.value, dateTo: dateTo.value, hasImage: hasImage.value, filterOpen: filterOpen.value, anchor: id, book: book.value }
}
function fallback(message: string): void {
  gateSeq += 1; readPort.value?.close(); readPort.value = null
  book.value = false; verifying.value = false; anchor.value = ""; gateError.value = message
}
async function switchView(reading: boolean): Promise<void> {
  if (!reading) {
    gateSeq += 1; readPort.value?.close(); readPort.value = null; book.value = false; verifying.value = false
    const query = { ...route.query }; delete query.view; void router.replace({ query }); return
  }
  if (book.value && readPort.value) return
  const mine = ++gateSeq
  verifying.value = true; gateError.value = ""
  let candidate: NotebookReadPort | undefined
  try {
    candidate = await createVerifiedNotebookReadPort(() => {
      if (!disposed && mine === gateSeq) fallback("登录、归属或恢复上下文已失效，已清除阅读正文；请重新核验。")
    })
    if (disposed || mine !== gateSeq) { candidate.close(); return }
    await candidate.assertCurrent()
    if (disposed || mine !== gateSeq) { candidate.close(); return }
    const scopeKey = JSON.stringify(await captureNotebookScope())
    if (scopeKey !== listScopeKey) {
      // A new dataset/session must never reuse A's row IDs or tag IDs for B's port.
      items.value = []; total.value = 0; anchor.value = ""; tagIds.value = []; tags.value = []
      await reload(); await loadTags(); await candidate.assertCurrent()
      if (disposed || mine !== gateSeq) { candidate.close(); return }
      listScopeKey = scopeKey
    }
    await candidate.assertCurrent()
    if (disposed || mine !== gateSeq) { candidate.close(); return }
    readPort.value?.close(); readPort.value = candidate; book.value = true
    if (!entryIds.value.includes(anchor.value)) anchor.value = entryIds.value[0] ?? ""
    void router.replace({ query: { ...route.query, view: "book" } })
  } catch (error) {
    candidate?.close()
    if (!disposed && mine === gateSeq) fallback(error instanceof Error ? error.message : "联网核验登录后可进入简册；普通列表仍可使用。")
  } finally { if (mine === gateSeq) verifying.value = false }
}
async function loginForBook(): Promise<void> {
  try {
    const scope = await captureNotebookScope()
    if (disposed) return
    rememberNotebookLogin({ ...state(), book: true }, scope)
    await router.push("/auth")
  } catch { notice.value = "归属核对失败，未保存跨页面阅读上下文。" }
}
watch(revision, () => {
  // flush:sync + v-if clears the old paper before the 250ms search debounce.
  protectedTarget.value = false
}, { flush: "sync" })
watch(items, list => {
  if (restoring.value || !list.length) return
  if (!list.some(entry => entry.id === anchor.value)) {
    if (anchor.value) notice.value = "原简已不在当前筛选中，已转到首篇。"
    anchor.value = list[0]?.id ?? ""
  }
}, { flush: "sync" })
// Fill a newly widened spread without moving or even-aligning its ID anchor.
watch([book, anchor, width, items, loading], () => {
  if (!book.value || restoring.value || loading.value || queryError.value || width.value < 1200 || !hasMore.value) return
  const index = entryIds.value.indexOf(anchor.value)
  if (index >= 0 && index + 2 > items.value.length) void loadMore()
})
async function move(direction: -1 | 1): Promise<void> {
  if (moving.value || loading.value || !readPort.value) return
  const version = revision.value, origin = anchor.value, port = readPort.value, viewport = width.value
  const cancelled = () => disposed || version !== revision.value || anchor.value !== origin || port !== readPort.value || width.value !== viewport || Boolean(queryError.value)
  const target = notebookTargetIndex(entryIds.value, origin, direction, viewport)
  if (target < 0) return
  moving.value = true; protectedTarget.value = false
  try {
    await port.assertCurrent()
    // Crossing the 20-row boundary fetches just the next batch (also fills a double spread).
    const desired = target + (viewport >= 1200 ? 2 : 1)
    if (desired > entryIds.value.length && hasMore.value) await loadMore()
    if (cancelled()) return
    const targetId = entryIds.value[target]
    if (!targetId) return
    await port.assertCurrent()
    // Final async guard may outlive a filter, port, viewport or result change.
    if (cancelled() || entryIds.value[target] !== targetId) return
    anchor.value = targetId
  } catch { if (!disposed && port === readPort.value) fallback("阅读上下文已失效，请重新核验。") }
  finally { moving.value = false }
}
function refreshUnavailable(): void {
  const key = `${revision.value}:${anchor.value}`
  if (disposed || key === missingRefreshKey) return
  missingRefreshKey = key
  notice.value = "当前日记已删除或不再可读，已重查共享结果；异常记录仍保留诊断，不反复自动重试。"
  void reload()
}
async function editFromBook(id: string): Promise<void> {
  const port = readPort.value, version = revision.value
  if (!port || loading.value) return
  try {
    const entry = await port.readEntry(id)
    await port.assertCurrent()
    if (disposed || port !== readPort.value || version !== revision.value) return
    if (!entry) { notice.value = "此简已删除，已重查列表。"; await reload(); return }
    if (!canOpenScheduleDiaryContent(entry.content)) { notice.value = "此简含当前编辑器不支持的版本或结构，已保留为只读，未进入编辑。"; return }
    if (entry.fromScheduleId !== null) { protectedTarget.value = true; return }
    await open(id, port)
  } catch { if (!disposed && port === readPort.value) fallback("此简或登录上下文已变化，未进入编辑。") }
}

const tags = ref<Tag[]>([])
const tagError = ref("")
const filterOpen = ref(false)
const coverByEntry = ref<Record<string, string>>({})
const imageCountByEntry = ref<Record<string, number>>({})

// 封面与张数共用同一个序号：它们在同一个 watch 里一起取，
// 分成两个序号只会给自己留下“封面是新的、张数是旧的”这种半旧状态。
let coverSeq = 0

const {
  distance,
  ready,
  refreshing,
  pullStyle,
  onTouchStart,
  onTouchMove,
  onTouchEnd,
  onTouchCancel,
} = usePullToRefresh(reload, loading)

const tagNameById = computed<Record<string, string>>(() =>
  Object.fromEntries(tags.value.map((tag) => [tag.id, tag.name])),
)

const hasFilters = computed(() => Boolean(
  keyword.value.trim() || tagIds.value.length || dateFrom.value || dateTo.value || hasImage.value !== undefined,
))

const groups = computed(() => {
  if (order.value === "updatedAtDesc") {
    return items.value.length
      ? [{ key: "updated", label: "近改动", items: items.value }]
      : []
  }

  const result: Array<{ key: string; label: string; items: EntryListItem[] }> = []
  for (const entry of items.value) {
    const key = entry.entryDate.slice(0, 7)
    const last = result[result.length - 1]
    if (last?.key === key) {
      last.items.push(entry)
    } else {
      const [year, month] = key.split("-")
      result.push({ key, label: `${year} 年 ${Number(month)} 月`, items: [entry] })
    }
  }
  return result
})

async function loadTags(): Promise<void> {
  try {
    tags.value = await tagRepo.list()
  } catch (reason) {
    tagError.value = reason instanceof Error ? reason.message : "标签读取失败"
  }
}

function toggleTag(id: string): void {
  const selected = new Set(tagIds.value)
  if (selected.has(id)) selected.delete(id)
  else selected.add(id)
  tagIds.value = [...selected]
}

function clearFilters(): void {
  tagIds.value = []
  dateFrom.value = ""
  dateTo.value = ""
  hasImage.value = undefined
}

async function open(id: string, expectedPort?: NotebookReadPort): Promise<void> {
  try {
    const scope = await captureNotebookScope()
    const entry = await entryRepo.get(id)
    if (!entry || entry.isDeleted !== 0 || entry.deletedAt !== null) { notice.value = "此简已删除或不再可读。"; await reload(); return }
    // Recheck scope after the entry read; do not capture a stale source ID for another account.
    const current = await captureNotebookScope()
    if (JSON.stringify(scope) !== JSON.stringify(current)) throw new Error("账号或本机归属已变化，请重试。")
    if (expectedPort) {
      await expectedPort.assertCurrent()
      if (expectedPort !== readPort.value || !book.value || !entryIds.value.includes(id)) return
      if (!canOpenScheduleDiaryContent(entry.content)) { notice.value = "此简含当前编辑器不支持的版本或结构，已保留为只读，未进入编辑。"; return }
      if (entry.fromScheduleId !== null) { protectedTarget.value = true; return }
    }
    rememberNotebookReturn(state(id), scope, true)
    await router.push(`/entry/${id}`)
  } catch (error) { notice.value = error instanceof Error ? error.message : "未能进入编辑" }
}

/** 是否有真正写下的文字。L2 之后图片不再进 contentText，所以这就是可靠判据。 */
function hasText(entry: EntryListItem): boolean {
  return entry.contentText.trim().length > 0
}

function snippet(entry: EntryListItem): TextPart[] {
  return highlightParts(entry.contentText, keyword.value)
}

/** 只在没有真文本时用。纯展示，绝不写回 contentText（铁律 1）。 */
function fallbackExcerpt(entry: EntryListItem): string {
  return entryExcerpt(entry.contentText, imageCountByEntry.value[entry.id] ?? 0)
}

function dayLabel(entryDate: string): string {
  const [, month, day] = entryDate.split("-")
  return `${Number(month)}月${Number(day)}日`
}

// This metadata path is used only by ordinary rows; no thumbnail component is mounted in book mode.
watch([items, book], async ([list, reading]) => {
  const mine = ++coverSeq
  coverByEntry.value = {}; imageCountByEntry.value = {}
  if (reading) return
  try {
    const ids = list.map(entry => entry.id)
    const [covers, counts] = await Promise.all([mediaRepo.firstByEntries(ids), mediaRepo.countByEntries(ids)])
    if (mine !== coverSeq || disposed) return
    coverByEntry.value = covers; imageCountByEntry.value = counts
  } catch { if (mine === coverSeq) tagError.value = "列表图片信息读取失败，可重试检简。" }
})
watch(keyword, value => {
  const query = { ...route.query }
  if (value.trim()) query.q = value.trim(); else delete query.q
  void router.replace({ query })
})
watch(() => route.query.q, value => {
  const next = typeof value === "string" ? value : ""
  if (next !== keyword.value.trim()) keyword.value = next
})
watch(() => route.query.view, value => {
  if (!initialized || disposed) return
  if (value !== "book" && book.value) void switchView(false)
  else if (value === "book" && !book.value && !verifying.value) void switchView(true)
})
onMounted(async () => {
  window.addEventListener("resize", resize)
  try {
    const scope = await captureNotebookScope()
    if (disposed) return
    listScopeKey = JSON.stringify(scope)
    const saved = takeNotebookLogin(scope) ?? takeNotebookReturn(scope)
    if (saved) {
      keyword.value = saved.keyword; order.value = saved.order; tagIds.value = saved.tagIds
      dateFrom.value = saved.dateFrom; dateTo.value = saved.dateTo; hasImage.value = saved.hasImage
      filterOpen.value = saved.filterOpen; anchor.value = saved.anchor
    } else if (typeof route.query.q === "string") keyword.value = route.query.q
    await reload()
    const version = revision.value
    // Only list metadata, at most five additional 20-row batches. No full-library bodies/Blobs.
    if (saved?.anchor) {
      for (let count = 0; count < 5 && !entryIds.value.includes(saved.anchor) && hasMore.value && !queryError.value && version === revision.value && !disposed; count += 1) await loadMore()
      if (version === revision.value && !entryIds.value.includes(saved.anchor)) notice.value = "原简已变化或不在本次有限结果中，已返回当前首篇。"
    }
    if (disposed) return
    if (!entryIds.value.includes(anchor.value)) anchor.value = entryIds.value[0] ?? ""
    restoring.value = false
    void loadTags()
    if (saved?.book || route.query.view === "book") await switchView(true)
  } catch { if (!disposed) { notice.value = "归属核对失败，保留普通列表。"; await reload() } }
  finally { if (!disposed) { restoring.value = false; initialized = true } }
})
onUnmounted(() => {
  disposed = true; gateSeq += 1; coverSeq += 1
  window.removeEventListener("resize", resize)
  readPort.value?.close(); readPort.value = null
})
</script>

<style scoped>
.list-page.book-page { max-width: 1232px; }
.reader-notice { margin: 12px 0; color: var(--color-ink-soft); overflow-wrap: anywhere; }

.list-page {
  position: relative;
  transition: transform 160ms ease-out;
}

.pull-indicator {
  position: absolute;
  right: 0;
  bottom: 100%;
  left: 0;
  padding: 8px;
  opacity: 0;
  text-align: center;
  font-size: var(--text-caption);
  line-height: var(--leading-caption);
  color: var(--color-ink-faint);
}

.pull-indicator.visible {
  opacity: 1;
}

.head,
.bar,
.filter-heading,
.sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.page-title {
  margin: 0;
  font-family: var(--font-cn-serif);
  font-size: var(--text-section);
  line-height: var(--leading-section);
  color: var(--color-ink);
}

.plain {
  padding: 6px 2px;
  border: none;
  background: none;
  font-size: var(--text-body);
  line-height: var(--leading-body);
  color: var(--color-ink-soft);
  cursor: pointer;
}

.accent {
  color: var(--color-bamboo);
}

.view-switch {
  display: flex;
  gap: 6px;
  margin-top: 12px;
}

.view-button,
.chip {
  padding: 4px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-card);
  background: transparent;
  font-size: var(--text-caption);
  line-height: var(--leading-caption);
  color: var(--color-ink-soft);
  cursor: pointer;
}

.view-button.active,
.chip.on {
  border-color: var(--color-bamboo);
  background: var(--color-bamboo);
  color: #fff;
}

.view-button:disabled {
  color: var(--color-ink-faint);
  cursor: not-allowed;
}

.search {
  width: 100%;
  margin: 12px 0 8px;
  padding: 8px 12px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-card);
  background: var(--color-paper-deep);
  outline: none;
  font-size: var(--text-body);
  line-height: var(--leading-body);
  color: var(--color-ink);
}

.search:focus {
  border-color: var(--color-bamboo-soft);
}

.filter-heading {
  min-height: 34px;
}

.filters {
  display: grid;
  gap: 12px;
  margin-bottom: 10px;
  padding: 12px;
  border-radius: var(--radius-card);
  background: var(--color-paper-deep);
}

.filter-row {
  display: grid;
  gap: 6px;
}

.filter-label,
.filter-row small,
.count,
.filter-error {
  font-size: var(--text-caption);
  line-height: var(--leading-caption);
  color: var(--color-ink-faint);
}

.filter-options,
.orders {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.date-range {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.date-range label {
  display: grid;
  gap: 4px;
  font-size: var(--text-caption);
  color: var(--color-ink-soft);
}

.date-range input {
  min-width: 0;
  padding: 6px;
  border: 1px solid var(--line-soft);
  border-radius: 6px;
  background: var(--color-paper);
  color: var(--color-ink);
}

.filter-actions {
  text-align: right;
}

.filter-error {
  margin: 0;
  color: var(--color-ji);
}

.bar {
  margin: 4px 0;
}

.group-title {
  position: sticky;
  top: 0;
  z-index: 4;
  margin: 20px 0 6px;
  padding: 6px 0;
  background: color-mix(in srgb, var(--color-paper) 94%, transparent);
  backdrop-filter: blur(6px);
  font-family: var(--font-cn-serif);
  font-size: var(--text-caption);
  font-weight: normal;
  line-height: var(--leading-caption);
  color: var(--color-ink-faint);
}

.group-title.static {
  position: static;
}

.list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.row {
  display: flex;
  width: 100%;
  gap: 12px;
  padding: 10px 0;
  border: none;
  border-bottom: 1px solid var(--line-soft);
  background: none;
  text-align: left;
  cursor: pointer;
}

.row-copy {
  display: block;
  min-width: 0;
  flex: 1;
}

.row-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.row-title {
  overflow: hidden;
  font-family: var(--font-cn-serif);
  font-size: var(--text-section);
  line-height: var(--leading-section);
  color: var(--color-ink);
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 徽标与日期同属“右侧附注”，一起 flex: none，
   保证标题继续吃掉剩余宽度并正常省略号截断 */
.row-tail {
  display: flex;
  flex: none;
  align-items: baseline;
  gap: 8px;
}

.row-day {
  flex: none;
  font-size: var(--text-caption);
  line-height: var(--leading-caption);
  color: var(--color-ink-faint);
}

.img-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: var(--text-caption);
  line-height: var(--leading-caption);
  color: var(--color-ink-faint);
  font-variant-numeric: tabular-nums;
}

.img-badge svg {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.row-snippet {
  display: -webkit-box;
  margin-top: 2px;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  font-size: var(--text-body);
  line-height: var(--leading-body);
  color: var(--color-ink-soft);
}

/* 「4 张图片」不是用户写的字，视觉上要弱于真文本 */
.row-snippet.faint {
  color: var(--color-ink-faint);
}

.row-snippet .hit {
  color: var(--color-bamboo);
}

.row-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 5px;
  font-size: var(--text-caption);
  line-height: var(--leading-caption);
  color: var(--color-ink-faint);
}

.tag-name:empty {
  display: none;
}

.tag-name:not(:empty)::before {
  content: "#";
}

.more {
  display: block;
  width: 100%;
  margin: 20px 0;
  padding: 10px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-card);
  background: none;
  font-family: var(--font-cn-kai);
  font-size: var(--text-body);
  line-height: var(--leading-body);
  color: var(--color-ink-soft);
  cursor: pointer;
}

.empty,
.end {
  margin: 32px 0;
  font-family: var(--font-cn-kai);
  text-align: center;
  color: var(--color-ink-faint);
}

.empty {
  font-size: var(--text-body);
  line-height: var(--leading-body);
}

.end {
  font-size: var(--text-caption);
  line-height: var(--leading-caption);
}

.skeleton-list {
  display: grid;
  gap: 10px;
  margin-top: 12px;
}

.skeleton-row {
  display: flex;
  gap: 12px;
}

.skeleton-thumb,
.skeleton-copy i {
  display: block;
  border-radius: 8px;
  background: linear-gradient(90deg, var(--color-paper-deep), var(--color-paper), var(--color-paper-deep));
  background-size: 200% 100%;
  animation: shimmer 1.2s linear infinite;
}

.skeleton-thumb {
  width: 88px;
  height: 88px;
  flex: 0 0 88px;
}

.skeleton-copy {
  display: grid;
  min-width: 0;
  flex: 1;
  align-content: center;
  gap: 12px;
}

.skeleton-copy i {
  height: 16px;
}

.skeleton-copy i:last-child {
  width: 72%;
}

@keyframes shimmer {
  to { background-position: -200% 0; }
}

@media (prefers-reduced-motion: reduce) {
  .list-page {
    transition: none;
  }

  .skeleton-thumb,
  .skeleton-copy i {
    animation: none;
  }
}
</style>
