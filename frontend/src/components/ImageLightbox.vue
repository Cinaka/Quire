<template>
  <!-- Teleport 是修「关闭按钮被裁掉」的一半：灯箱原本挂在 .local-image 里面，
       那个容器 position: relative + overflow: hidden，编辑区祖先一旦有 transform，
       position: fixed 的包含块就不再是视口。挂到 body 下就不受任何祖先影响。 -->
  <Teleport to="body">
    <div
      v-if="open"
      class="lightbox"
      role="dialog"
      aria-modal="true"
      :style="viewportStyle"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @wheel.prevent="onWheel"
      @contextmenu.prevent
    >
      <img
        v-if="url"
        ref="imgRef"
        class="full"
        :src="url"
        :alt="alt"
        draggable="false"
        :style="imageStyle"
      />

      <button
        ref="closeRef"
        type="button"
        class="close"
        aria-label="关闭"
        @pointerdown.stop
        @click.stop="close"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, reactive, ref, toRef, watch } from "vue"

import { useObjectUrl } from "@/composables/useObjectUrl"

const props = defineProps<{
  open: boolean
  blob: Blob | null
  alt: string
}>()

const emit = defineEmits<{
  close: []
}>()

const MIN_SCALE = 1
const MAX_SCALE = 4
/** 与 LocalImageView 的 MOVE_TOLERANCE 同值：位移在此以内算「点一下」 */
const TAP_TOLERANCE = 8

const closeRef = ref<HTMLButtonElement | null>(null)
const imgRef = ref<HTMLImageElement | null>(null)

const blob = toRef(props, "blob")
// 关闭期间置 null，useObjectUrl 会 revoke 原图 URL：原图可能有几 MB，
// 九张图各挂一个实例时不能让它们常驻。
const source = computed(() => (props.open ? blob.value : null))
const url = useObjectUrl(source)

/* ---------- 视觉视口：修「关闭按钮显示不全」 ---------- */

// 不能用 inset: 0。fixed 定位的是「布局视口」，而用户看到的是「视觉视口」；
// 页面被 pinch-zoom 或被软键盘顶起时两者不重合，右上角会被推到屏幕外。
const viewport = reactive({ left: 0, top: 0, width: 0, height: 0 })

const viewportStyle = computed(() => ({
  left: `${viewport.left}px`,
  top: `${viewport.top}px`,
  width: `${viewport.width}px`,
  height: `${viewport.height}px`,
}))

function syncViewport(): void {
  const v = window.visualViewport
  if (!v) {
    viewport.left = 0
    viewport.top = 0
    viewport.width = window.innerWidth
    viewport.height = window.innerHeight
    return
  }
  viewport.left = v.offsetLeft
  viewport.top = v.offsetTop
  viewport.width = v.width
  viewport.height = v.height
}

/* ---------- 缩放与平移：修「原页面跟着放大」 ---------- */

const scale = ref(1)
const tx = ref(0)
const ty = ref(0)
const gesturing = ref(false)

const imageStyle = computed(() => ({
  transform: `translate3d(${tx.value}px, ${ty.value}px, 0) scale(${scale.value})`,
  // 手势进行中禁掉过渡，否则跟手会有一帧延迟；松手后的回弹才用过渡。
  transition: gesturing.value ? "none" : "transform 0.18s ease-out",
}))

const pointers = new Map<number, { x: number; y: number }>()
let startDistance = 1
let startScale = 1
let startAnchor = { x: 0, y: 0 }
let startTx = 0
let startTy = 0
let moved = 0

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))
}

// 夹紧平移量：放大后图片边缘不许被拖离视口内侧，1× 时强制归零。
function clampTranslate(): void {
  const el = imgRef.value
  if (!el) return
  const maxX = Math.max(0, (el.clientWidth * scale.value - viewport.width) / 2)
  const maxY = Math.max(0, (el.clientHeight * scale.value - viewport.height) / 2)
  tx.value = Math.min(maxX, Math.max(-maxX, tx.value))
  ty.value = Math.min(maxY, Math.max(-maxY, ty.value))
}

function resetZoom(): void {
  scale.value = 1
  tx.value = 0
  ty.value = 0
}

function center(): { x: number; y: number } {
  return {
    x: viewport.left + viewport.width / 2,
    y: viewport.top + viewport.height / 2,
  }
}

/**
 * 围绕锚点缩放。推导：屏幕位置 = 中心 + t + scale × 图内向量，
 * 于是要让锚点下的那个像素不动，t_new = anchor − center − ratio × (旧锚点 − center − t_old)。
 * 少了这一步就是「从画面正中放大」，手指按住的位置会跑掉。
 */
function zoomAround(next: number, anchor: { x: number; y: number }, from: { x: number; y: number }): void {
  const c = center()
  const ratio = next / startScale
  tx.value = anchor.x - c.x - ratio * (from.x - c.x - startTx)
  ty.value = anchor.y - c.y - ratio * (from.y - c.y - startTy)
  scale.value = next
  clampTranslate()
}

function beginGesture(): void {
  const list = [...pointers.values()]
  startScale = scale.value
  startTx = tx.value
  startTy = ty.value

  if (list.length >= 2) {
    const [a, b] = list
    startDistance = Math.hypot(a.x - b.x, a.y - b.y) || 1
    startAnchor = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    return
  }
  if (list.length === 1) startAnchor = { x: list[0].x, y: list[0].y }
}

function onPointerDown(event: PointerEvent): void {
  // 逐指捕获，不是整体捕获：多指时每个 pointerId 各自捕获，
  // 手指滑出遮罩范围仍能收到 pointermove。
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  gesturing.value = true
  if (pointers.size === 1) moved = 0
  beginGesture()
}

function onPointerMove(event: PointerEvent): void {
  const point = pointers.get(event.pointerId)
  if (!point) return
  point.x = event.clientX
  point.y = event.clientY
  // touch-action: none 已经把手势交给我们，这里再 preventDefault 挡掉
  // 浏览器可能残留的滚动 / 缩放意图。
  event.preventDefault()

  if (pointers.size >= 2) {
    const [a, b] = [...pointers.values()]
    const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1
    const anchor = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    zoomAround(clampScale(startScale * (distance / startDistance)), anchor, startAnchor)
    moved = TAP_TOLERANCE + 1 // 捏过就不再算「点一下」
    return
  }

  const dx = event.clientX - startAnchor.x
  const dy = event.clientY - startAnchor.y
  moved = Math.max(moved, Math.hypot(dx, dy))
  if (scale.value <= 1) return

  tx.value = startTx + dx
  ty.value = startTy + dy
  clampTranslate()
}

function onPointerUp(event: PointerEvent): void {
  if (!pointers.delete(event.pointerId)) return

  // 还有手指在屏幕上：以剩下的手指重新起算，避免松开一指时图片瞬移。
  if (pointers.size > 0) {
    beginGesture()
    return
  }

  gesturing.value = false
  if (scale.value < 1.02) resetZoom() // 捏回 1× 附近就归位，免得留下零点几像素偏移
  if (moved > TAP_TOLERANCE) return

  // 点一下：已放大时先回到 1×（此时用户多半是想看全图，不是想关），未放大才关闭。
  if (scale.value > 1) {
    resetZoom()
    return
  }
  close()
}

function onWheel(event: WheelEvent): void {
  startScale = scale.value
  startTx = tx.value
  startTy = ty.value
  const anchor = { x: event.clientX, y: event.clientY }
  zoomAround(clampScale(scale.value * (event.deltaY > 0 ? 0.9 : 1.1)), anchor, anchor)
}

/* ---------- 背景滚动锁、键盘与生命周期 ---------- */

/**
 * 背景滚动锁必须带实例级标记。
 *
 * 每个 LocalImageView 都各自挂了一个 ImageLightbox，九宫格就是九个实例。
 * 无条件写 document.body.style.overflow 时，任意一个实例的 watch(immediate)
 * 或 onUnmounted 都会把别人正在用的锁解掉 —— 症状是灯箱开着背景却能滚。
 */
let locked = false

function lockScroll(on: boolean): void {
  if (on === locked) return
  locked = on
  document.body.style.overflow = on ? "hidden" : ""
}

function close(): void {
  emit("close")
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return
  event.preventDefault()
  close()
}

function unbind(): void {
  window.removeEventListener("keydown", onKeydown)
  window.visualViewport?.removeEventListener("resize", syncViewport)
  window.visualViewport?.removeEventListener("scroll", syncViewport)
}

watch(
  () => props.open,
  async (open) => {
    unbind()
    lockScroll(open)
    pointers.clear()
    gesturing.value = false
    resetZoom()
    if (!open) return

    syncViewport()
    window.addEventListener("keydown", onKeydown)
    // 视觉视口会随 pinch-zoom、软键盘、地址栏收放而变，必须跟着同步，
    // 只在打开时读一次不够。
    window.visualViewport?.addEventListener("resize", syncViewport)
    window.visualViewport?.addEventListener("scroll", syncViewport)

    // 焦点落到灯箱自己的关闭按钮上。NodeView 的 dropFocus() 只保证「不弹键盘」，
    // 这一步才保证焦点不会被背景的 contenteditable 抢回去（抢回去就再弹一次）。
    await nextTick()
    closeRef.value?.focus()
  },
  { immediate: true },
)

// 异常路径：灯箱开着时组件被销毁（拖拽后 NodeView 重建、直接后退路由），
// 不解锁就整个 App 再也滚不动。
onUnmounted(() => {
  unbind()
  lockScroll(false)
})
</script>

<style scoped>
.lightbox {
  position: fixed;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.92);
  /* 这一行是「原页面跟着放大」的正解：把双指手势从浏览器手里接过来。
     写 pan-y / manipulation 都不行，pinch 仍会被浏览器当页面缩放吃掉。 */
  touch-action: none;
  overscroll-behavior: contain;
  user-select: none;
  -webkit-user-select: none;
}

.full {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  transform-origin: center center;
  will-change: transform;
  /* 手势统一由遮罩接：图片不参与命中测试，event.currentTarget 永远是遮罩。 */
  pointer-events: none;
}

.close {
  position: absolute;
  top: calc(8px + env(safe-area-inset-top));
  right: calc(8px + env(safe-area-inset-right));
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  cursor: pointer;
  touch-action: manipulation;
}

.close svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
}
</style>
