<template>
  <NodeViewWrapper
    class="local-image"
    :class="{ selected, dragging }"
    :data-media-id="mediaId || undefined"
    draggable="false"
    @dragstart.prevent
  >
    <!-- 预览格子同时是拖拽把手：短按开大图，长按 350ms 进入拖拽。
         pointerdown 必须 .prevent，否则 ProseMirror 会把选区设成 NodeSelection
         并把焦点拉回 contenteditable，移动版 Chrome 随即弹出软键盘。 -->
    <button
      v-if="url"
      type="button"
      class="preview"
      contenteditable="false"
      draggable="false"
      :aria-label="alt || '查看大图'"
      @pointerdown.stop.prevent="onPointerDown"
      @contextmenu.prevent
      @click.stop.prevent
    >
      <img :src="url" :alt="alt" draggable="false" />
    </button>
    <div v-else-if="missing" class="missing" contenteditable="false">图片已丢失</div>
    <div v-else class="loading" contenteditable="false" />

    <div class="image-actions" contenteditable="false">
      <button
        type="button"
        class="remove"
        aria-label="删除图片"
        title="删除图片"
        @pointerdown.stop.prevent
        @click.stop="props.deleteNode()"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M4 7h16" />
          <path d="M10 4h4M10 11v6M14 11v6" />
          <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
        </svg>
      </button>
    </div>

    <ImageLightbox :open="lightboxOpen" :blob="fullBlob" :alt="alt" @close="close" />
  </NodeViewWrapper>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue"
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/vue-3"
import ImageLightbox from "@/components/ImageLightbox.vue"
import { useObjectUrl } from "@/composables/useObjectUrl"
import { moveImageNode } from "@/editor/media"
import { mediaRepo } from "@/repo"
import { parseLocalSrc } from "@/shared/text"

const props = defineProps<NodeViewProps>()

// 长按阈值与位移容差：与 P1-5 下拉刷新、E2 原稿保持同一组值。
const HOLD_MS = 350
const MOVE_TOLERANCE = 8

const mediaId = ref("")
const missing = ref(false)
const dragging = ref(false)
const lightboxOpen = ref(false)
const blob = ref<Blob | null>(null)
const fullBlob = ref<Blob | null>(null)
const url = useObjectUrl(blob)

const alt = computed(() =>
  typeof props.node.attrs.alt === "string" ? props.node.attrs.alt : "",
)
const selected = computed(() => props.selected)

// 两个请求序号各管一条异步路径：缩图与原图。NodeView 会被复用，
// 旧 Promise 回来得丢掉，否则会把上一张图盖到新格子上。
let resolveSeq = 0
let fullSeq = 0

async function resolve(src: string): Promise<void> {
  const mine = ++resolveSeq
  blob.value = null
  missing.value = false

  const id = parseLocalSrc(src)
  mediaId.value = id ?? ""
  if (!id) return

  const thumb = await mediaRepo.getThumb(id)
  if (mine !== resolveSeq) return
  if (!thumb) missing.value = true
  else blob.value = thumb
}

watch(
  () => props.node.attrs.src,
  (src) => {
    void resolve(typeof src === "string" ? src : "")
  },
  { immediate: true },
)

/* ---------- 拖拽 ---------- */

let holdTimer: number | null = null
let activePointer: number | null = null
let host: HTMLElement | null = null
let startX = 0
let startY = 0
let painted: HTMLElement | null = null

function clearDropPaint(): void {
  if (!painted) return
  painted.classList.remove("drop-before", "drop-after")
  painted = null
}

function paintDropTarget(el: HTMLElement | null, side: "before" | "after"): void {
  if (painted && painted !== el) clearDropPaint()
  if (!el) return
  painted = el
  el.classList.toggle("drop-before", side === "before")
  el.classList.toggle("drop-after", side === "after")
}

// 落点只靠 elementFromPoint，不缓存 ProseMirror position（每次 transaction 都会变）。
function targetAt(
  x: number,
  y: number,
): { el: HTMLElement; id: string; side: "before" | "after" } | null {
  const el = document
    .elementFromPoint(x, y)
    ?.closest<HTMLElement>(".local-image[data-media-id]")
  const id = el?.dataset.mediaId
  if (!el || !id || id === mediaId.value) return null

  const rect = el.getBoundingClientRect()
  const side = x < rect.left + rect.width / 2 ? "before" : "after"
  return { el, id, side }
}

function cleanupDrag(): void {
  if (holdTimer !== null) window.clearTimeout(holdTimer)
  holdTimer = null
  window.removeEventListener("pointermove", onPointerMove)
  window.removeEventListener("pointerup", onPointerUp)
  window.removeEventListener("pointercancel", onPointerCancel)
  if (host && activePointer !== null && host.hasPointerCapture(activePointer)) {
    host.releasePointerCapture(activePointer)
  }
  host = null
  activePointer = null
  dragging.value = false
  clearDropPaint()
}

function activateDrag(): void {
  holdTimer = null
  if (!host || activePointer === null) return
  try {
    host.setPointerCapture(activePointer)
  } catch {
    cleanupDrag()
    return
  }
  dragging.value = true
  if (typeof navigator.vibrate === "function") navigator.vibrate(10)
}

function onPointerDown(event: PointerEvent): void {
  if (!mediaId.value || event.button !== 0) return
  cleanupDrag()

  activePointer = event.pointerId
  host = event.currentTarget as HTMLElement
  startX = event.clientX
  startY = event.clientY

  window.addEventListener("pointermove", onPointerMove, { passive: false })
  window.addEventListener("pointerup", onPointerUp)
  window.addEventListener("pointercancel", onPointerCancel)

  holdTimer = window.setTimeout(activateDrag, HOLD_MS)
}

function onPointerMove(event: PointerEvent): void {
  if (event.pointerId !== activePointer) return
  const moved = Math.hypot(event.clientX - startX, event.clientY - startY)

  if (!dragging.value) {
    if (moved <= MOVE_TOLERANCE) return
    // 鼠标：按住拖就是拖，不用等 350ms。
    // 触屏：长按尚未成立就滑了 = 用户想滚页，放开手势。
    if (event.pointerType === "mouse") activateDrag()
    else cleanupDrag()
    if (!dragging.value) return
  }

  event.preventDefault()
  const hit = targetAt(event.clientX, event.clientY)
  paintDropTarget(hit?.el ?? null, hit?.side ?? "before")
}

function onPointerUp(event: PointerEvent): void {
  if (event.pointerId !== activePointer) return

  const wasDragging = dragging.value
  const moved = Math.hypot(event.clientX - startX, event.clientY - startY)
  const hit = wasDragging ? targetAt(event.clientX, event.clientY) : null
  cleanupDrag()

  if (wasDragging) {
    // 长按后原地抬手（hit 为 null）就是个空操作，不开大图。
    if (hit) moveImageNode(props.editor, mediaId.value, hit.id, hit.side)
    return
  }
  if (moved <= MOVE_TOLERANCE) void open()
}

function onPointerCancel(event: PointerEvent): void {
  if (event.pointerId !== activePointer) return
  cleanupDrag()
}

/* ---------- 灯箱 ---------- */

// 开灯箱前必须把焦点从 contenteditable 上抢下来，否则移动版弹软键盘遂图。
// 两句都要：activeElement.blur() 收当前焦点，editor.commands.blur() 防 PM 回焦。
function dropFocus(): void {
  const active = document.activeElement
  if (active instanceof HTMLElement) active.blur()
  props.editor.commands.blur()
}

async function open(): Promise<void> {
  if (!mediaId.value) return
  dropFocus()

  const mine = ++fullSeq
  const item = await mediaRepo.get(mediaId.value)
  if (mine !== fullSeq || !item) return

  fullBlob.value = item.blob
  lightboxOpen.value = true
}

// 关灯箱后绝不回焦编辑器：回焦 = 再弹一次键盘。
function close(): void {
  fullSeq += 1
  lightboxOpen.value = false
  fullBlob.value = null
}

onUnmounted(() => {
  resolveSeq += 1
  fullSeq += 1
  cleanupDrag()
})
</script>

<style scoped>
.local-image {
  position: relative;
  display: block;
  overflow: hidden;
  border-radius: var(--radius-card);
  background: rgba(0, 0, 0, 0.04);
}

.local-image.selected {
  outline: 2px solid var(--color-ink-light);
  outline-offset: 1px;
}

.local-image.dragging {
  opacity: 0.45;
}

/* 拖拽中的插入位提示。类名是命伤时用 JS 打到另一个同类组件实例上的，
   但两者 scope id 相同，scoped 样式仍然生效。 */
.local-image.drop-before::after,
.local-image.drop-after::after {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--color-ji);
  pointer-events: none;
}

.local-image.drop-before::after {
  left: 0;
}

.local-image.drop-after::after {
  right: 0;
}

.preview {
  display: block;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
  background: none;
  cursor: pointer;
  /* pan-y：纵向滚页照旧，而“按住不动”不构成 pan，长按才抢得到手势。
     写 none 会让九宫格占满屏时整页无处滚动。 */
  touch-action: pan-y;
  -webkit-touch-callout: none;
  user-select: none;
}

.preview img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  pointer-events: none;
}

.missing,
.loading {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: var(--text-caption);
  line-height: var(--leading-caption);
  color: var(--color-ink-light);
}

.image-actions {
  position: absolute;
  top: 4px;
  right: 4px;
}

.remove {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  cursor: pointer;
  touch-action: manipulation;
}

.remove svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
