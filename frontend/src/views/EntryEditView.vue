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
    // 走 flushSafely 而不是裸 persist()：800ms 窗口里可能已累积多个 revision，
    // 只跑一轮 persist 可能排不空（persistLatest 只合并到开始那一刻的 revision）。
    flushSafely()
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
  const doc = editorRef.value?.snapshot() ??
    loadedDoc.value ?? {
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
  // 图片必须单独判。L2/L3 之后「只贴了图」的正文纯文本是空串，
  // 不把它算进来就会静默不落库，图片还会被 24 小时孤儿清理带走。
  // collectMediaIds 在下面 attach 时本来就要调，这里多调一次是纯 JSON 遍历。
  const hasImage = collectMediaIds(doc).length > 0

  // 空的新日记不落库；只有心情、天气或标签也属于有效日记。
  if (targetId === null && !targetTitle.trim() && !text.trim() && !hasMeta && !hasImage) {
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

/**
 * 排空到 flush 调用期间出现的最新 revision。会向上抛：路由守卫靠它判断拦不拦。
 *
 * do/while 不会死循环：persistLatest() 成功时 savedRevision 单调递增到
 * 当时的 editRevision；抛出时整个 flush() 直接 reject 退出循环。
 * 唯一能让它多转一圈的情形是“保存期间又有输入”，而那正是它存在的理由。
 */
async function flush(): Promise<void> {
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }

  do {
    await persist()
  } while (savedRevision < editRevision)
}

/**
 * “发完就不管”的唯一入口。给三个无法 await 的时机用：beforeunload、
 * visibilitychange、onBeforeUnmount。
 *
 * 不能写成 void flush()：void 只丢弃返回值，不注册任何 rejection handler。
 * E3 把 flush() 改成会 reject 之后，写库失败（配额溢出、条目已被彻底删除后的
 * update）会变成未捕获 rejection：控制台一片红，而用户只看到状态卡在“保存中”。
 */
function flushSafely(): void {
  void flush().catch(() => {
    status.value = "保存失败"
  })
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
  flushSafely()
}

// 切后台 / 切标签页时落盘。只在 hidden 时做：visibilitychange 双向触发，
// 回前台时并没有新输入。这是移动端唯一可靠的那道保险。
function onVisibilityChange(): void {
  if (document.visibilityState === "hidden") flushSafely()
}

window.addEventListener("beforeunload", onBeforeUnload)
document.addEventListener("visibilitychange", onVisibilityChange)

onBeforeUnmount(() => {
  loadRevision += 1
  window.removeEventListener("beforeunload", onBeforeUnload)
  document.removeEventListener("visibilitychange", onVisibilityChange)
  // 此处无法 await（钩子同步），但写入仍会在后台跑完：
  // persistLatest 已在开头快照了 doc 与表单，不依赖已销毁的 editorRef。
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
