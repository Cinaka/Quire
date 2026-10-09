<template>
  <section v-if="error || recovery?.draft" class="draft-notice" aria-label="预简安全草稿">
    <p v-if="error" role="alert">{{ error }}。原草稿未自动清除，请保留并检查备份。</p>
    <template v-else-if="recovery?.draft">
      <p>{{ draftRecoveryMessage(recovery.status) }}</p>
      <p>{{ recovery.draft.remindDate }} · {{ recovery.draft.title || "无题" }}</p>
      <div class="actions">
        <button type="button" :disabled="busy" @click="emit('resume')">恢复草稿</button>
        <button type="button" :disabled="busy" @click="emit('discard-request')">弃去草稿…</button>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import type { ScheduleDraftReadResult } from "@/db/scheduleDraftRepo"
import { draftRecoveryMessage } from "@/shared/schedulePresentation"

defineProps<{ recovery: ScheduleDraftReadResult | null; busy?: boolean; error?: string }>()
const emit = defineEmits<{ resume: []; "discard-request": [] }>()
</script>

<style scoped>
.draft-notice { padding: 14px; border: 1px solid var(--color-bamboo-soft); border-radius: 8px; color: var(--color-ink-soft); }
.actions { display: flex; flex-wrap: wrap; gap: 12px; }
button { color: var(--color-bamboo); cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .5; }
</style>
