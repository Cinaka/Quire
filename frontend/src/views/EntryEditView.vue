<template>
  <div class="mx-auto w-full max-w-2xl px-4 py-4">
    <header class="flex items-center justify-between gap-3">
      <button type="button" class="plain" @click="back">返回</button>
      <span class="status">{{ status }}</span>
      <button v-if="entryId" type="button" class="plain danger" @click="discard">删除</button>
    </header>

    <input v-model="title" class="title" placeholder="无题" @input="schedule" />

    <EntryMetaFields
      :key="routeId"
      v-model:mood="mood"
      v-model:weather="weather"
      v-model:tag-ids="tagIds"
      @change="schedule"
    />

    <!-- v-if 不能省。loadedDoc 是 onMounted 里异步读出来的，而 DiaryEditor
         内部的 useEditor 在它自己 setup 阶段就用当时的 props.doc 建好了实例，
         那时候还是 null。之后 props 变了 Tiptap 也不会重新灌内容，
         结果就是标题正常、正文空白。 -->
    <DiaryEditor v-if="ready" ref="editorRef" :doc="loadedDoc" @change="onChange" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from "vue-router"

import DiaryEditor from "@/components/DiaryEditor.vue"
import EntryMetaFields from "@/components/EntryMetaFields.vue"
import { entryRepo, mediaRepo } from "@/repo"
import { collectMediaIds, toPlainText } from "@/shared/text"
import { isLocalDate, todayLocal } from "@/shared/time"
import { CONTENT_SCHEMA_VERSION, type TiptapDoc } from "@/shared/types"

const route = useRoute()
const router = useRouter()

/** null 表示这篇还没落库。点开编辑器不创建任何数据，第一次保存时才创建 */
const entryId = ref<string | null>(null)
const title = ref("")
const mood = ref<string | null>(null)
const weather = ref<string | null>(null)
const tagIds = ref<string[]>([])
const loadedDoc = ref<TiptapDoc | null>(null)
/** 旧文读完之前不能挂载编辑器，否则它会以空文档定型 */
const ready = ref(false)
const status = ref("")
const editorRef = ref<InstanceType<typeof DiaryEditor> | null>(null)

let timer: number | null = null
let pending = false
let entryDate = todayLocal()
let editRevision = 0
let savedRevision = 0
let persistQueue: Promise<void> = Promise.resolve()
let loadRevision = 0

const routeId = computed(() => (typeof route.params.id === "string" ? route.params.id : "new"))

/** 把视图恢复成「什么都没加载」的状态。切换条目时必须整体重置，漏一个字段就是串文 */
function reset(): void {
  entryId.value = null
  title.value = ""
  mood.value = null
  weather.value = null
  tagIds.value = []
  loadedDoc.value = null
  entryDate = todayLocal()
  pending = false
  status.value = ""
  editRevision = 0
  savedRevision = 0
  persistQueue = Promise.resolve()
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }
}

async function load(id: string): Promise<void> {
  const revision = ++loadRevision
  reset()

  if (id !== "new") {
    const entry = await entryRepo.get(id)
    if (revision !== loadRevision) return
    if (!entry) {
      void router.replace("/")
      return
    }
    entryId.value = entry.id
    title.value = entry.title
    mood.value = entry.mood
    weather.value = entry.weather
    tagIds.value = [...entry.tagIds]
    loadedDoc.value = entry.content?.doc ?? null
    entryDate = entry.entryDate
  } else {
    const requested = route.query.date
    if (typeof requested === "string" && isLocalDate(requested) && requested <= todayLocal()) {
      entryDate = requested
    } else {
      entryDate = todayLocal()
    }
  }

  if (revision !== loadRevision) return
  // 新建和编辑两条路径都在这里置位，保证行为一致
  ready.value = true
}

onMounted(() => {
  void load(routeId.value)
})

/**
 * vue-router 在同一条规则内换参数时会复用实例、不重跑 onMounted，
 * 所以必须先排空上一篇的保存，再销毁旧编辑器并读取下一篇。
 */
watch(routeId, async (next, prev) => {
  if (next === prev) return
  // 新建落库后自己 replace 出来的地址变化（/entry/new → /entry/{id}）不算切换
  if (next === entryId.value) return

  await flush()
  ready.value = false
  await load(next)
})

/** 内容或元数据变化后排一次保存。 */
function schedule(): void {
  editRevision += 1
  pending = true
  status.value = "未保存"

  if (timer !== null) window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    timer = null
    void persist().catch(() => {
      status.value = "保存失败"
    })
  }, 800)
}

function onChange(): void {
  schedule()
}

/**
 * 所有保存串到同一条 Promise 队列。run 保留本次错误给 flush / 路由守卫，
 * persistQueue 自身吞掉错误，以便下一轮保存仍能继续。
 */
function persist(): Promise<void> {
  const run = persistQueue.then(() => persistLatest())
  persistQueue = run.catch(() => undefined)
  return run
}

async function persistLatest(): Promise<void> {
  if (savedRevision >= editRevision) return

  // 真正轮到本任务时再取最新 revision 和表单快照，队列中的旧请求自然合并。
  const revision = editRevision
  const doc = editorRef.value?.snapshot() ?? loadedDoc.value ?? {
    type: "doc" as const,
    content: [{ type: "paragraph" }],
  }
  const targetId = entryId.value
  const targetTitle = title.value
  const targetDate = entryDate
  const targetMood = mood.value
  const targetWeather = weather.value
  const targetTagIds = [...new Set(tagIds.value)]
  const content = { schemaVersion: CONTENT_SCHEMA_VERSION, doc }
  const text = toPlainText(content)
  const hasMeta = Boolean(targetMood || targetWeather || targetTagIds.length)

  // 空的新日记不落库；只有心情、天气或标签也属于有效日记。
  if (targetId === null && !targetTitle.trim() && !text.trim() && !hasMeta) {
    savedRevision = Math.max(savedRevision, revision)
    pending = savedRevision < editRevision
    status.value = pending ? "未保存" : ""
    return
  }

  status.value = "保存中"
  const payload = {
    title: targetTitle,
    content,
    entryDate: targetDate,
    mood: targetMood,
    weather: targetWeather,
    tagIds: targetTagIds,
  }

  let savedId: string
  if (targetId === null) {
    const created = await entryRepo.create(payload)
    savedId = created.id
    entryId.value = created.id
    // 只在地址栏还停在 /entry/new 时改写，避免跟用户的跳转抢路由
    if (routeId.value === "new") void router.replace(`/entry/${created.id}`)
  } else {
    savedId = targetId
    await entryRepo.update(targetId, payload)
  }

  // 图片认领必须在正文落库之后；正文 JSON 顺序是媒体 sortOrder 的真相来源。
  await mediaRepo.attach(savedId, collectMediaIds(doc))

  savedRevision = Math.max(savedRevision, revision)
  pending = savedRevision < editRevision

  // 保存期间若又有输入，旧保存不能清除“未保存”状态。
  if (entryId.value === savedId) {
    status.value = pending ? "未保存" : "已保存"
  }
}

/** 排空到 flush 调用期间出现的最新 revision。 */
async function flush(): Promise<void> {
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }

  do {
    await persist()
  } while (savedRevision < editRevision)
}

async function discard(): Promise<void> {
  if (!entryId.value) return
  if (!window.confirm("移入断简？可以再恢复。")) return

  await flush()
  const id = entryId.value
  await entryRepo.remove(id)
  void router.replace("/")
}

async function back(): Promise<void> {
  await flush()
  void router.back()
}

/** 换到另一篇（同路由换参数）时触发。onBeforeRouteLeave 在这种情况下不触发 */
onBeforeRouteUpdate(async () => {
  await flush()
})

/** 路由切走前落盘。不做这一步，快速点返回会丢掉最后 800ms 的输入 */
onBeforeRouteLeave(async () => {
  await flush()
})

// 关标签页 / 刷新前落盘。浏览器不会等待异步完成，但仍尽早触发队列。
function onBeforeUnload(): void {
  void flush()
}

function onVisibilityChange(): void {
  if (document.visibilityState === "hidden") {
    void flush().catch(() => {
      status.value = "保存失败"
    })
  }
}

window.addEventListener("beforeunload", onBeforeUnload)
document.addEventListener("visibilitychange", onVisibilityChange)

onBeforeUnmount(() => {
  loadRevision += 1
  window.removeEventListener("beforeunload", onBeforeUnload)
  document.removeEventListener("visibilitychange", onVisibilityChange)
  void flush()
})
</script>

<style scoped>
.plain {
  padding: 6px 2px;
  border: none;
  background: none;
  font-size: 15px;
  color: var(--color-ink-soft);
  cursor: pointer;
}

.danger {
  color: var(--color-ji);
}

.status {
  font-size: 13px;
  color: var(--color-ink-faint);
}

.title {
  width: 100%;
  margin: 12px 0 4px;
  padding: 0;
  border: none;
  background: none;
  outline: none;
  font-family: var(--font-cn-serif);
  font-size: 24px;
  color: var(--color-ink);
}

.title::placeholder {
  color: var(--color-ink-faint);
}
</style>
