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
import { onBeforeUnmount, onMounted, ref } from "vue"
import { onBeforeRouteLeave, useRoute, useRouter } from "vue-router"

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

onMounted(async () => {
  const id = route.params.id

  if (typeof id === "string" && id !== "new") {
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

  // 新建和编辑两条路径都要置位。新建时 loadedDoc 本来就是 null，
  // 但仍然要等到这里才挂载，保证两条路径行为一致。
  ready.value = true
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

  const content = { schemaVersion: CONTENT_SCHEMA_VERSION, doc }

  // 约束一：toPlainText 收的是 EntryContent 整包（它内部读 content.doc），
  // 不是裸 doc。传错了不报错，只会静默返回空串，让搜索永远搜不到东西。
  // 这里算出来的 text 只用于下面的空内容判断——真正写库的 contentText
  // 由 repo 自己从 content 派生，保证与 content 同一次写入。
  const text = toPlainText(content)

  // 约束二：空日记不落库。用户点进来又退出去不该留垃圾数据
  if (!entryId.value && !title.value.trim() && !text.trim()) {
    pending = false
    status.value = ""
    return
  }

  status.value = "保存中"

  // 注意 payload 里没有 contentText。EntryCreateDto 里就没这个字段,
  // create / update 内部会调 toPlainText 派生它。手动传会被 TS 拦下,
  // 也会让派生逻辑出现两个来源。
  const payload = {
    title: title.value,
    content,
    entryDate,
  }

  if (entryId.value === null) {
    const created = await entryRepo.create(payload)
    entryId.value = created.id
    // 换成真实 ID，这样刷新页面还能回到这篇
    void router.replace(`/entry/${created.id}`)
  } else {
    await entryRepo.update(entryId.value, payload)
  }

  // 约束三：图片认领必须在正文落库之后。
  // 反过来做，若正文写入失败，图片就挂在一篇不存在的日记上了。
  await mediaRepo.attach(entryId.value, collectMediaIds(doc))

  pending = false
  status.value = "已保存"
}

function flush(): void {
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }
  void persist()
}

async function discard(): Promise<void> {
  if (!entryId.value) return
  if (!window.confirm("移入断简？可以再恢复。")) return

  pending = false
  await entryRepo.remove(entryId.value)
  void router.replace("/")
}

function back(): void {
  flush()
  void router.push("/")
}

/** 路由切走前落盘。不做这一步，快速点返回会丢掉最后 800ms 的输入 */
onBeforeRouteLeave(() => {
  flush()
})

/** 关标签页 / 刷新前落盘。注意这里只能同步触发，await 不会被等待 */
function onBeforeUnload(): void {
  flush()
}

window.addEventListener("beforeunload", onBeforeUnload)

onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", onBeforeUnload)
  flush()
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
