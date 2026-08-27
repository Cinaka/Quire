<template>
  <span class="entry-thumbnail" aria-hidden="true">
    <img v-if="url" :src="url" alt="" />
  </span>
</template>

<script setup lang="ts">
import { onUnmounted, ref, watch } from "vue"

import { useObjectUrl } from "@/composables/useObjectUrl"
import { mediaRepo } from "@/repo"

const props = defineProps<{ mediaId: string | null }>()

const blob = ref<Blob | null>(null)
const url = useObjectUrl(blob)
let seq = 0

watch(
  () => props.mediaId,
  async (id) => {
    const mine = ++seq
    blob.value = null
    if (!id) return

    const next = await mediaRepo.getThumb(id)
    if (mine === seq) blob.value = next ?? null
  },
  { immediate: true },
)

onUnmounted(() => {
  seq += 1
})
</script>

<style scoped>
.entry-thumbnail {
  display: block;
  width: 88px;
  height: 88px;
  flex: 0 0 88px;
  overflow: hidden;
  border-radius: 8px;
  background: var(--color-paper-deep);
}

.entry-thumbnail img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

@media (max-width: 420px) {
  .entry-thumbnail {
    width: 72px;
    height: 72px;
    flex-basis: 72px;
  }
}
</style>
