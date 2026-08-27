
<template>
  <Teleport to="body">
    <div
      v-if="props.open"
      class="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      @click.self="close"
    >
      <button
        type="button"
        class="close-button"
        aria-label="关闭图片预览"
        @click="close"
      >
        ×
      </button>

      <img v-if="url" :src="url" :alt="props.alt" />
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onUnmounted, toRef, watch } from "vue"

import { useObjectUrl } from "@/composables/useObjectUrl"

const props = defineProps<{
  open: boolean
  blob: Blob | null
  alt: string
}>()

const emit = defineEmits<{
  close: []
}>()

const blob = toRef(props, "blob")
const source = computed(() => (props.open ? blob.value : null))
const url = useObjectUrl(source)

function close(): void {
  emit("close")
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return
  event.preventDefault()
  close()
}

watch(
  () => props.open,
  (open) => {
    window.removeEventListener("keydown", onKeydown)
    if (open) window.addEventListener("keydown", onKeydown)
  },
  { immediate: true },
)

onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown)
})
</script>

<style scoped>
.image-lightbox {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 56px 24px 24px;
  overflow: auto;
  overscroll-behavior: contain;
  background: rgb(0 0 0 / 82%);
}

.image-lightbox img {
  display: block;
  max-width: min(100%, 1200px);
  max-height: calc(100dvh - 80px);
  object-fit: contain;
  border-radius: 8px;
  box-shadow: 0 12px 40px rgb(0 0 0 / 35%);
}

.close-button {
  position: fixed;
  top: max(12px, env(safe-area-inset-top));
  right: max(12px, env(safe-area-inset-right));
  display: grid;
  width: 40px;
  height: 40px;
  padding: 0;
  border: 1px solid rgb(255 255 255 / 55%);
  border-radius: 999px;
  background: rgb(0 0 0 / 45%);
  color: #fff;
  font: inherit;
  font-size: 28px;
  line-height: 1;
  place-items: center;
  cursor: pointer;
}

.close-button:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}
</style>
