<template>
  <NodeViewWrapper class="local-image" :class="{ selected }">
    <img v-if="url" :src="url" :alt="alt" draggable="false" />
    <div v-else-if="missing" class="missing">图片已丢失</div>
    <div v-else class="loading" />
  </NodeViewWrapper>
</template>

<script setup lang="ts">
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/vue-3"
import { computed, onUnmounted, ref, watch } from "vue"

import { mediaRepo } from "@/repo"
import { parseLocalSrc } from "@/shared/text"

const props = defineProps<NodeViewProps>()

const url = ref("")
const missing = ref(false)

const alt = computed(() => (props.node.attrs.alt as string) ?? "")
const selected = computed(() => props.selected)

function release(): void {
  if (url.value) {
    URL.revokeObjectURL(url.value)
    url.value = ""
  }
}

async function resolve(src: string): Promise<void> {
  release()
  missing.value = false

  const id = parseLocalSrc(src)

  // 不是 local:// 协议就原样交给浏览器（比如将来 P2 同步后换成了远端 URL）
  if (!id) {
    url.value = src
    return
  }

  const item = await mediaRepo.get(id)
  if (!item) {
    // 记录被清理过、或者从别的设备同步来但图还没下载，都会走到这里。
    // 不能静默显示空白——用户会以为编辑器坏了。
    missing.value = true
    return
  }

  url.value = URL.createObjectURL(item.blob)
}

watch(
  () => props.node.attrs.src as string,
  (src) => {
    void resolve(src)
  },
  { immediate: true },
)

onUnmounted(release)
</script>

<style scoped>
.local-image {
  margin: 16px 0;
  line-height: 0;
}

.local-image img {
  max-width: 100%;
  border-radius: 8px;
}

.local-image.selected img {
  outline: 2px solid var(--color-bamboo);
  outline-offset: 2px;
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
