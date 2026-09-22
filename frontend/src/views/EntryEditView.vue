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

    <DiaryEditor v-if="ready" ref="editorRef" :doc="loadedDoc" @change="onChange" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from "vue-router"

import DiaryEditor from "@/components/DiaryEditor.vue"
import EntryMetaFields from "@/components/EntryMetaFields.vue"
import { draftRepo, entryRepo, mediaRepo, type EditorDraft } from "@/repo"
import { collectMediaIds, toPlainText } from "@/shared/text"
import { isLocalDate, todayLocal, utcNow } from "@/shared/time"
import { CONTENT_SCHEMA_VERSION, type TiptapDoc } from "@/shared/types"

const route = useRoute()
const router = useRouter()
const entryId = ref<string | null>(null)
const title = ref("")
const mood = ref<string | null>(null)
const weather = ref<string | null>(null)
const tagIds = ref<string[]>([])
const loadedDoc = ref<TiptapDoc | null>(null)
const ready = ref(false)
const status = ref("")
const editorRef = ref<InstanceType<typeof DiaryEditor> | null>(null)

let saveTimer: number | null = null
let draftTimer: number | null = null
let pending = false
let entryDate = todayLocal()
let editRevision = 0
let savedRevision = 0
let persistQueue: Promise<void> = Promise.resolve()
let loadRevision = 0

const routeId = computed(() => (typeof route.params.id === "string" ? route.params.id : "new"))
const emptyDoc = (): TiptapDoc => ({ type: "doc", content: [{ type: "paragraph" }] })

function clearTimers(): void {
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  if (draftTimer !== null) window.clearTimeout(draftTimer)
  saveTimer = null
  draftTimer = null
}

function reset(): void {
  clearTimers()
  entryId.value = null
  title.value = ""
  mood.value = null
  weather.value = null
  tagIds.value = []
  loadedDoc.value = null
  ready.value = false
  entryDate = todayLocal()
  pending = false
  status.value = ""
  editRevision = 0
  savedRevision = 0
  persistQueue = Promise.resolve()
}

function applyDraft(draft: EditorDraft): void {
  entryId.value = draft.entryId
  title.value = draft.title
  mood.value = draft.mood
  weather.value = draft.weather
  tagIds.value = [...draft.tagIds]
  loadedDoc.value = draft.doc
  entryDate = draft.entryDate
  editRevision = 1
  savedRevision = 0
  pending = true
  status.value = "已恢复安全草稿"
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
    entryDate =
      typeof requested === "string" && isLocalDate(requested) && requested <= todayLocal()
        ? requested
        : todayLocal()
  }

  const draft = await draftRepo.get()
  if (revision !== loadRevision) return
  if ((id === "new" && draft?.entryId === null) || (id !== "new" && draft?.entryId === id)) {
    applyDraft(draft)
  }
  ready.value = true
}

onMounted(() => void load(routeId.value))

watch(routeId, async (next, prev) => {
  if (next === prev || next === entryId.value) return
  await flush()
  await load(next)
})

function scheduleDraft(): void {
  if (draftTimer !== null) window.clearTimeout(draftTimer)
  draftTimer = window.setTimeout(() => {
    draftTimer = null
    saveDraftSafely()
  }, 3000)
}

function schedule(): void {
  editRevision += 1
  pending = true
  status.value = "未保存"
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    flushSafely()
  }, 800)
  scheduleDraft()
}

function onChange(): void {
  schedule()
}

function currentDoc(): TiptapDoc {
  return editorRef.value?.snapshot() ?? loadedDoc.value ?? emptyDoc()
}

async function saveDraft(): Promise<void> {
  const doc = currentDoc()
  const content = { schemaVersion: CONTENT_SCHEMA_VERSION, doc }
  const hasContent = Boolean(
    title.value.trim() ||
      toPlainText(content).trim() ||
      mood.value ||
      weather.value ||
      tagIds.value.length ||
      collectMediaIds(doc).length,
  )
  if (!hasContent) {
    await draftRepo.clear()
    return
  }
  await draftRepo.save({
    entryId: entryId.value,
    entryDate,
    title: title.value,
    mood: mood.value,
    weather: weather.value,
    tagIds: [...new Set(tagIds.value)],
    doc,
    updatedAt: utcNow(),
  })
}

function saveDraftSafely(): void {
  void saveDraft().catch(() => undefined)
}

async function clearDraft(): Promise<void> {
  if (draftTimer !== null) window.clearTimeout(draftTimer)
  draftTimer = null
  await draftRepo.clear()
}

function persist(): Promise<void> {
  const run = persistQueue.then(() => persistLatest())
  persistQueue = run.catch(() => undefined)
  return run
}

async function persistLatest(): Promise<void> {
  if (savedRevision >= editRevision) return
  const revision = editRevision
  const doc = currentDoc()
  const targetId = entryId.value
  const targetTitle = title.value
  const targetDate = entryDate
  const targetMood = mood.value
  const targetWeather = weather.value
  const targetTagIds = [...new Set(tagIds.value)]
  const content = { schemaVersion: CONTENT_SCHEMA_VERSION, doc }
  const text = toPlainText(content)
  const hasMeta = Boolean(targetMood || targetWeather || targetTagIds.length)
  const hasImage = collectMediaIds(doc).length > 0

  if (targetId === null && !targetTitle.trim() && !text.trim() && !hasMeta && !hasImage) {
    savedRevision = Math.max(savedRevision, revision)
    pending = savedRevision < editRevision
    status.value = pending ? "未保存" : ""
    await clearDraft()
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
    if (routeId.value === "new") void router.replace(`/entry/${created.id}`)
  } else {
    savedId = targetId
    await entryRepo.update(targetId, payload)
  }

  await mediaRepo.attach(savedId, collectMediaIds(doc))
  await clearDraft()
  savedRevision = Math.max(savedRevision, revision)
  pending = savedRevision < editRevision
  if (entryId.value === savedId) status.value = pending ? "未保存" : "已保存"
}

async function flush(): Promise<void> {
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  saveTimer = null
  do {
    await persist()
  } while (savedRevision < editRevision)
}

function flushSafely(): void {
  void flush().catch(() => {
    status.value = "保存失败，已保留安全草稿"
    saveDraftSafely()
  })
}

async function discard(): Promise<void> {
  if (!entryId.value || !window.confirm("移入断简？可以再恢复。")) return
  await flush()
  await entryRepo.remove(entryId.value)
  await clearDraft()
  void router.replace("/")
}

async function back(): Promise<void> {
  await flush()
  void router.back()
}

onBeforeRouteUpdate(async () => {
  await flush()
})

onBeforeRouteLeave(async () => {
  await flush()
})

function onBeforeUnload(): void {
  saveDraftSafely()
  flushSafely()
}

function onVisibilityChange(): void {
  if (document.visibilityState === "hidden") {
    saveDraftSafely()
    flushSafely()
  }
}

window.addEventListener("beforeunload", onBeforeUnload)
document.addEventListener("visibilitychange", onVisibilityChange)

onBeforeUnmount(() => {
  loadRevision += 1
  window.removeEventListener("beforeunload", onBeforeUnload)
  document.removeEventListener("visibilitychange", onVisibilityChange)
  saveDraftSafely()
  flushSafely()
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
.danger { color: var(--color-ji); }
.status { font-size: 13px; color: var(--color-ink-faint); }
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
.title::placeholder { color: var(--color-ink-faint); }
</style>
