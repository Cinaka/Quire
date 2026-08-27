<template>
  <section class="entry-meta" aria-label="日记元数据">
    <div class="field-group">
      <span class="field-label">心情</span>
      <div class="chip-list">
        <button
          v-for="option in MOOD_OPTIONS"
          :key="option.value"
          type="button"
          class="chip"
          :class="{ active: props.mood === option.value }"
          :aria-pressed="props.mood === option.value"
          :title="option.label"
          @click="toggleMood(option.value)"
        >
          <span aria-hidden="true">{{ option.value }}</span>
          <span>{{ option.label }}</span>
        </button>
      </div>
    </div>

    <div class="field-group">
      <span class="field-label">天气</span>
      <div class="chip-list">
        <button
          v-for="option in WEATHER_OPTIONS"
          :key="option.value"
          type="button"
          class="chip"
          :class="{ active: props.weather === option.value }"
          :aria-pressed="props.weather === option.value"
          :title="option.label"
          @click="toggleWeather(option.value)"
        >
          <span aria-hidden="true">{{ option.value }}</span>
          <span>{{ option.label }}</span>
        </button>
      </div>
    </div>

    <div class="field-group">
      <span class="field-label">标签</span>
      <div v-if="tags.length" class="chip-list">
        <button
          v-for="tag in tags"
          :key="tag.id"
          type="button"
          class="chip tag-chip"
          :class="{ active: props.tagIds.includes(tag.id) }"
          :aria-pressed="props.tagIds.includes(tag.id)"
          @click="toggleTag(tag.id)"
        >
          {{ tag.name }}
        </button>
      </div>

      <form class="tag-form" @submit.prevent="createTag">
        <input
          v-model="tagName"
          type="text"
          maxlength="64"
          autocomplete="off"
          placeholder="输入标签后按 Enter"
          aria-label="新标签名称"
        />
        <button type="submit" :disabled="creating">{{ creating ? "添加中" : "添加" }}</button>
      </form>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue"

import { tagRepo } from "@/repo"
import { MOOD_OPTIONS, WEATHER_OPTIONS } from "@/shared/entryMeta"
import type { Tag } from "@/shared/types"

const props = defineProps<{
  mood: string | null
  weather: string | null
  tagIds: string[]
}>()

const emit = defineEmits<{
  "update:mood": [string | null]
  "update:weather": [string | null]
  "update:tagIds": [string[]]
  change: []
}>()

const tags = ref<Tag[]>([])
const tagName = ref("")
const error = ref("")
const creating = ref(false)
let createRevision = 0

function changed(): void {
  emit("change")
}

function toggleMood(value: string): void {
  emit("update:mood", props.mood === value ? null : value)
  changed()
}

function toggleWeather(value: string): void {
  emit("update:weather", props.weather === value ? null : value)
  changed()
}

function toggleTag(id: string): void {
  const selected = new Set(props.tagIds)
  if (selected.has(id)) selected.delete(id)
  else selected.add(id)
  emit("update:tagIds", [...selected])
  changed()
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : "标签操作失败"
}

function sortTags(rows: Tag[]): Tag[] {
  return rows.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
}

async function loadTags(): Promise<void> {
  try {
    tags.value = await tagRepo.list()
  } catch (reason) {
    error.value = messageOf(reason)
  }
}

async function createTag(): Promise<void> {
  if (creating.value) return

  const revision = ++createRevision
  error.value = ""
  creating.value = true
  try {
    const tag = await tagRepo.getOrCreate(tagName.value)
    if (revision !== createRevision) return

    const byId = new Map(tags.value.map((item) => [item.id, item]))
    byId.set(tag.id, tag)
    tags.value = sortTags([...byId.values()])
    tagName.value = ""

    const selected = new Set(props.tagIds)
    if (!selected.has(tag.id)) {
      selected.add(tag.id)
      emit("update:tagIds", [...selected])
      changed()
    }
  } catch (reason) {
    if (revision === createRevision) error.value = messageOf(reason)
  } finally {
    if (revision === createRevision) creating.value = false
  }
}

onMounted(() => {
  void loadTags()
})

onUnmounted(() => {
  createRevision += 1
})
</script>

<style scoped>
.entry-meta {
  display: grid;
  gap: 12px;
  margin: 8px 0 14px;
}

.field-group {
  display: grid;
  gap: 6px;
}

.field-label {
  font-size: 13px;
  color: var(--color-ink-faint);
}

.chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 32px;
  padding: 5px 10px;
  border: 1px solid color-mix(in srgb, var(--color-ink-faint) 45%, transparent);
  border-radius: 999px;
  background: var(--color-paper);
  color: var(--color-ink-soft);
  cursor: pointer;
}

.chip.active {
  border-color: var(--color-bamboo);
  background: var(--color-bamboo-soft);
  color: var(--color-ink);
}

.tag-chip {
  max-width: 100%;
  overflow-wrap: anywhere;
}

.tag-form {
  display: flex;
  gap: 8px;
}

.tag-form input {
  min-width: 0;
  flex: 1;
  padding: 7px 10px;
  border: 1px solid color-mix(in srgb, var(--color-ink-faint) 45%, transparent);
  border-radius: 8px;
  background: var(--color-paper);
  color: var(--color-ink);
}

.tag-form button {
  padding: 7px 12px;
  border: 1px solid var(--color-bamboo);
  border-radius: 8px;
  background: var(--color-paper);
  color: var(--color-bamboo);
  cursor: pointer;
}

.tag-form button:disabled {
  cursor: wait;
  opacity: 0.6;
}

.error {
  margin: 0;
  font-size: 13px;
  color: var(--color-ji);
}
</style>
