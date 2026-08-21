<template>
  <div class="mx-auto w-full max-w-2xl px-4 py-4">
    <header class="flex items-center justify-between gap-3">
      <button type="button" class="plain" @click="back">返回</button>
      <span class="status">{{ status }}</span>
      <button v-if="entryId" type="button" class="plain danger" @click="discard">删除</button>
    </header>

    <input v-model="title" class="title" placeholder="无题" @input="schedule" />

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
import { collectMediaIds } from "@/editor/media"
import { entryRepo, mediaRepo } from "@/repo"
import { toPlainText } from "@/shared/text"
import { todayLocal } from "@/shared/time"
import { CONTENT_SCHEMA_VERSION, type TiptapDoc } from "@/shared/types"

const route = useRoute()
const router = useRouter()

/** null 表示这篇还没落库。点开编辑器不创建任何数据，第一次保存时才创建 */
const entryId = ref<string | null>(null)
const title = ref("")
const loadedDoc = ref<TiptapDoc | null>(null)
/** 旧文读完之前不能挂载编辑器，否则它会以空文档定型 */
const ready = ref(false)
const status = ref("")
const editorRef = ref<InstanceType<typeof DiaryEditor> | null>(null)

let timer: number | null = null
let pending = false
let entryDate = todayLocal()

const routeId = computed(() => (typeof route.params.id === "string" ? route.params.id : "new"))

/** 把视图恢复成「什么都没加载」的状态。切换条目时必须整体重置，漏一个字段就是串文 */
function reset(): void {
  entryId.value = null
  title.value = ""
  loadedDoc.value = null
  entryDate = todayLocal()
  pending = false
  status.value = ""
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }
}

async function load(id: string): Promise<void> {
  reset()

  if (id !== "new") {
    const entry = await entryRepo.get(id)
    if (!entry) {
      void router.replace("/")
      return
    }
    entryId.value = entry.id
    title.value = entry.title
    loadedDoc.value = entry.content?.doc ?? null
    entryDate = entry.entryDate
  }

  // 新建和编辑两条路径都在这里置位，保证行为一致
  ready.value = true
}

onMounted(() => {
  void load(routeId.value)
})

/**
 * 这个 watch 是本步的主角。
 *
 * vue-router 在同一条规则内换参数时会复用实例、不重跑 onMounted，
 * 所以必须自己接住参数变化。三件事的顺序不能变：
 *   1. await flush()  —— 先把上一篇的挂起保存写完（见下方 targetId 快照）
 *   2. ready = false  —— 让 DiaryEditor 卸载并 destroy()，丢掉旧编辑器实例
 *   3. load(next)     —— 读新的一篇，读完再把 ready 置回 true 重建编辑器
 *
 * 第 2 步不能省。P1-3 定的约定是「编辑器只在数据就绪后创建一次、创建完不受 props 影响」，
 * 那条约定的代价就是切换条目时必须走一次真正的销毁重建，不能靠 setContent 灌内容。
 */
watch(routeId, async (next, prev) => {
  if (next === prev) return
  // 新建落库后自己 replace 出来的地址变化（/entry/new → /entry/{id}）不算切换
  if (next === entryId.value) return

  await flush()
  ready.value = false
  await load(next)
})

/** 内容变了就排一次保存。800ms 是权衡：再短会频繁写库，再长丢失窗口太大 */
function schedule(): void {
  pending = true
  status.value = "未保存"

  if (timer !== null) window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    void persist()
  }, 800)
}

function onChange(): void {
  schedule()
}

async function persist(): Promise<void> {
  if (!pending) return

  // 一律从编辑器现取，不用事件里带过来的值——事件可能已经过期
  const doc = editorRef.value?.snapshot() ?? null
  if (!doc) return

  // 把写入目标在 await 之前快照住。
  // 这是修串文的第二道闸：即使调用方忘了先 flush，这次写入也只会落到
  // 发起时那一篇上，而不会跟着 entryId 的后续变化跑到另一篇去。
  const targetId = entryId.value
  const targetTitle = title.value
  const targetDate = entryDate

  const content = { schemaVersion: CONTENT_SCHEMA_VERSION, doc }

  // 约束一：toPlainText 收的是 EntryContent 整包（它内部读 content.doc），不是裸 doc。
  // 这里算出来的 text 只用于下面的空内容判断——真正写库的 contentText 由 repo 自己派生。
  const text = toPlainText(content)

  // 约束二：空日记不落库。用户点进来又退出去不该留垃圾数据
  if (targetId === null && !targetTitle.trim() && !text.trim()) {
    pending = false
    status.value = ""
    return
  }

  status.value = "保存中"

  // payload 里没有 contentText。EntryCreateDto 里就没这个字段，
  // create / update 内部会调 toPlainText 派生它。
  const payload = { title: targetTitle, content, entryDate: targetDate }

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

  // 约束三：图片认领必须在正文落库之后。
  // 反过来做，若正文写入失败，图片就挂在一篇不存在的日记上了。
  await mediaRepo.attach(savedId, collectMediaIds(doc))

  // 期间已经切到别的条目了，就别再改状态文字，否则新页面会闪一下「已保存」
  if (entryId.value !== savedId) return

  pending = false
  status.value = "已保存"
}

/** 改成 async。所有「离开前保存」的地方都必须 await 它，这是修串文的第一道闸 */
async function flush(): Promise<void> {
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }
  await persist()
}

async function discard(): Promise<void> {
  if (!entryId.value) return
  if (!window.confirm("移入断简？可以再恢复。")) return

  pending = false
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }
  await entryRepo.remove(entryId.value)
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

/** 关标签页 / 刷新前落盘。注意这里只能同步触发，await 不会被等待 */
function onBeforeUnload(): void {
  void flush()
}

window.addEventListener("beforeunload", onBeforeUnload)

onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", onBeforeUnload)
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
