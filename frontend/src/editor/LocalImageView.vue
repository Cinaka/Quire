<template>
  <NodeViewWrapper
    class="local-image"
    :class="{ selected, dragging }"
    :data-media-id="mediaId || undefined"
  >
    <button
      v-if="url"
      type="button"
      class="preview"
      contenteditable="false"
      @pointerdown.stop
      @click.stop="open"
    >
      <img :src="url" :alt="alt" draggable="false" />
    </button>
    <div v-else-if="missing" class="missing">图片已丢失</div>
    <div v-else class="loading" />

    <div class="image-actions" contenteditable="false">
      <button
        type="button"
        class="drag-handle"
        aria-label="拖动图片排序"
        @pointerdown.stop="startDrag"
        @click.stop
      >
        移
      </button>
      <button
        type="button"
        aria-label="删除图片"
        @pointerdown.stop
        @click.stop="props.deleteNode()"
      >
        删
      </button>
    </div>

    <ImageLightbox
      :open="lightboxOpen"
      :blob="fullBlob"
      :alt="alt"
      @close="close"
    />
  </NodeViewWrapper>
</template>

<script setup lang="ts">
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/vue-3"
import { computed, onUnmounted, ref, watch } from "vue"

import ImageLightbox from  "@/components/ImageLightbox.vue"
import { useObjectUrl } from "@/composables/useObjectUrl"
import { moveImageNode } from "@/editor/media"
import { mediaRepo } from "@/repo"
import { parseLocalSrc } from "@/shared/text"

const props = defineProps<NodeViewProps>()

const blob = ref<Blob | null>(null)
const url = useObjectUrl(blob)
const fullBlob = ref<Blob | null>(null)
const lightboxOpen = ref(false)
const mediaId = ref("")
const missing = ref(false)
const dragging = ref(false)

const alt = computed(() => (props.node.attrs.alt as string) ?? "")
const selected = computed(() => props.selected)

let resolveSeq = 0
let fullSeq = 0
let holdTimer: number | null = null
let activePointer: number | null = null
let startX = 0
let startY = 0
let sourceMediaId = ""
let handle: HTMLElement | null = null

async function resolve(src: string): Promise<void> {
  const mine = ++resolveSeq
  fullSeq += 1
  lightboxOpen.value = false
  fullBlob.value = null
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

async function open(): Promise<void> {
  const id = mediaId.value
  if (!id) return

  const mine = ++fullSeq
  const item = await mediaRepo.get(id)
  if (mine !== fullSeq || mediaId.value !== id || !item) return

  fullBlob.value = item.blob
  lightboxOpen.value = true
}

function close(): void {
  fullSeq += 1
  lightboxOpen.value = false
  fullBlob.value = null
}

function cleanupDrag(): void {
  if (holdTimer !== null) window.clearTimeout(holdTimer)
  holdTimer = null
  window.removeEventListener("pointermove", onPointerMove)
  window.removeEventListener("pointerup", finishDrag)
  window.removeEventListener("pointercancel", cancelDrag)

  if (handle && activePointer !== null && handle.hasPointerCapture(activePointer)) {
    handle.releasePointerCapture(activePointer)
  }

  activePointer = null
  sourceMediaId = ""
  handle = null
  dragging.value = false
}

function activateDrag(): void {
  holdTimer = null
  if (!handle || activePointer === null) return

  try {
    handle.setPointerCapture(activePointer)
    dragging.value = true
  } catch {
    cleanupDrag()
  }
}

function startDrag(event: PointerEvent): void {
  if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return

  cleanupDrag()
  activePointer = event.pointerId
  startX = event.clientX
  startY = event.clientY
  sourceMediaId = mediaId.value
  handle = event.currentTarget as HTMLElement

  window.addEventListener("pointermove", onPointerMove, { passive: false })
  window.addEventListener("pointerup", finishDrag)
  window.addEventListener("pointercancel", cancelDrag)

  if (event.pointerType === "mouse") {
    activateDrag()
    if (dragging.value) event.preventDefault()
  } else {
    holdTimer = window.setTimeout(activateDrag, 350)
  }
}

function onPointerMove(event: PointerEvent): void {
  if (event.pointerId !== activePointer) return

  const moved = Math.hypot(event.clientX - startX, event.clientY - startY)
  if (!dragging.value && moved > 8) {
    cleanupDrag()
    return
  }

  if (dragging.value) event.preventDefault()
}

function finishDrag(event: PointerEvent): void {
  if (event.pointerId !== activePointer) return

  if (dragging.value && sourceMediaId) {
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>(".local-image[data-media-id]")
    const targetId = target?.dataset.mediaId

    if (target && targetId) {
      const rect = target.getBoundingClientRect()
      const side = event.clientX < rect.left + rect.width / 2 ? "before" : "after"
      moveImageNode(
        props.editor as unknown as Parameters<typeof moveImageNode>[0],
        sourceMediaId,
        targetId,
        side,
      )
    }
  }

  cleanupDrag()
}

function cancelDrag(): void {
  cleanupDrag()
}

watch(
  () => props.node.attrs.src as string,
  (src) => {
    void resolve(src)
  },
  { immediate: true },
)

onUnmounted(() => {
  resolveSeq += 1
  fullSeq += 1
  cleanupDrag()
})
</script>

<style scoped>
.local-image {
  position: relative;
  margin: 16px 0;
  line-height: 0;
}

.preview {
  display: block;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: zoom-in;
}

.local-image img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 8px;
}

.local-image.selected img {
  outline: 2px solid var(--color-bamboo);
  outline-offset: 2px;
}

.local-image.dragging {
  opacity: 0.72;
}

.image-actions {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  gap: 6px;
  line-height: 1;
}

.image-actions button {
  min-width: 32px;
  min-height: 32px;
  border: 1px solid color-mix(in srgb, var(--color-ink-faint) 35%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--color-paper) 88%, transparent);
  color: var(--color-ink);
  cursor: pointer;
}

.drag-handle {
  touch-action: manipulation;
  cursor: grab;
}

.local-image.dragging .drag-handle {
  cursor: grabbing;
}

.loading,
.missing {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 120px;
  border-radius: 8px;
  background: var(--color-paper-deep);
  font-size: 14px;
  line-height: 1.5;
  color: var(--color-ink-faint);
}

.missing {
  color: var(--color-ji);
}
</style>
