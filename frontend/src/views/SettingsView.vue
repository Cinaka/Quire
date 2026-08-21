<template>
  <div class="mx-auto w-full max-w-2xl px-4 py-4">
    <header class="head">
      <button type="button" class="plain" @click="router.push('/')">今简</button>
      <h1 class="page-title">设置</h1>
      <span class="spacer" />
    </header>

    <section class="card">
      <h2 class="card-title">简册</h2>
      <dl class="kv">
        <div><dt>在册</dt><dd>{{ stats?.entries ?? "—" }} 简</dd></div>
        <div><dt>断简</dt><dd>{{ stats?.deleted ?? "—" }} 简</dd></div>
        <div><dt>图片</dt><dd>{{ stats?.media ?? "—" }} 张 · {{ formatBytes(stats?.mediaBytes) }}</dd></div>
        <div><dt>本域已用</dt><dd>{{ formatBytes(usage) }} / {{ formatBytes(quota) }}{{ ratioText }}</dd></div>
      </dl>

      <p v-if="nearLimit" class="warn">
        本域存储已用逾八成。请先导出备份，再清理断简或删去大图，否则新的日记可能写不进来。
      </p>
      <p v-else-if="ratio === null" class="note">此浏览器未提供配额信息，故不显示占比。</p>

      <button type="button" class="line-btn" @click="router.push('/trash')">
        断简{{ stats?.deleted ? `（${stats.deleted}）` : "" }}
      </button>
    </section>

    <section class="card">
      <h2 class="card-title">防蠹</h2>
      <p class="note">
        导出一份全量备份，含全部日记、标签、图片与断简中的残简。文件只在本机生成，不经服务器。
      </p>

      <button type="button" class="line-btn" :disabled="busy" @click="exportBackup">
        {{ exporting ? exportLabel : "导出备份" }}
      </button>

      <p class="note">
        导入时同名标签自动归并；同一简以<b>较新的一份</b>为准，本机更新则保留本机。
      </p>

      <label class="line-btn as-label">
        <span>{{ importing ? "正在导入……" : "导入备份" }}</span>
        <input type="file" accept="application/json,.json" :disabled="busy" @change="onPick" />
      </label>

      <p v-if="message" class="msg" :class="{ bad: failed }">{{ message }}</p>
    </section>

    <section class="card">
      <h2 class="card-title">关于</h2>
      <p class="quote">厌从薄宦校青简，悔别故山思白云。</p>
      <p class="note">青简 · 一编青简，半生浮沉。本阶段数据全部存于本机浏览器。</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { useRouter } from "vue-router"

import { saveBlob } from "@/capabilities/download"
import { useStorageUsage } from "@/composables/useStorageUsage"
import { backupRepo } from "@/repo"
import { backupFileName } from "@/shared/backup"
import { formatBytes } from "@/shared/bytes"

const router = useRouter()

const { stats, usage, quota, ratio, nearLimit, refresh } = useStorageUsage()

const exporting = ref(false)
const importing = ref(false)
const exportLabel = ref("正在编册……")
const message = ref("")
const failed = ref(false)

const busy = computed(() => exporting.value || importing.value)

const ratioText = computed(() =>
  ratio.value === null ? "" : `（${Math.round(ratio.value * 100)}%）`,
)

onMounted(() => {
  void refresh()
})

async function exportBackup(): Promise<void> {
  exporting.value = true
  message.value = ""
  failed.value = false

  try {
    const file = await backupRepo.exportAll((done, total) => {
      exportLabel.value = total ? `正在编册…… ${done}/${total}` : "正在编册……"
    })

    // 不传缩进。图片 base64 本来就大，缩进能让文件再胖一圈而没人会去读它
    const blob = new Blob([JSON.stringify(file)], { type: "application/json" })
    saveBlob(blob, backupFileName())

    message.value = `已导出 ${file.counts.entries} 简、${file.counts.media} 张图片。`
  } catch (err) {
    failed.value = true
    message.value = `导出失败：${(err as Error).message}`
  } finally {
    exporting.value = false
    exportLabel.value = "正在编册……"
  }
}

async function onPick(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  importing.value = true
  message.value = ""
  failed.value = false

  try {
    // 先 parse 再交给 repo。JSON 语法错误要在这里就说清楚，
    // 不要混进 checkBackup 的「结构不对」里——两种问题的修法完全不同
    const text = await file.text()
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      throw new Error("文件不是合法的 JSON，可能已损坏")
    }

    const r = await backupRepo.importAll(raw, "preferNewer")
    const parts = [`新增 ${r.entriesAdded} 简`, `更新 ${r.entriesUpdated} 简`]
    if (r.entriesSkipped) parts.push(`跳过 ${r.entriesSkipped} 简`)
    if (r.entriesTooNew) parts.push(`${r.entriesTooNew} 简正文版本过新，未导入`)
    parts.push(`图片 ${r.mediaAdded} 张`)
    message.value = `${parts.join("，")}。`

    await refresh()
  } catch (err) {
    failed.value = true
    message.value = `导入失败：${(err as Error).message}`
  } finally {
    importing.value = false
    // 清空 value，否则再选同一个文件不会触发 change
    input.value = ""
  }
}
</script>

<style scoped>
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.spacer {
  width: 32px;
}

.page-title {
  margin: 0;
  font-family: var(--font-cn-serif);
  font-size: 20px;
  line-height: 1.4;
  color: var(--color-ink);
}

.plain {
  padding: 6px 2px;
  border: none;
  background: none;
  font-size: 15px;
  line-height: 1.7;
  color: var(--color-ink-soft);
  cursor: pointer;
}

.card {
  margin-top: 16px;
  padding: 14px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-card);
  background: var(--color-paper-deep);
}

.card-title {
  margin: 0 0 8px;
  font-family: var(--font-cn-serif);
  font-size: 20px;
  font-weight: normal;
  line-height: 1.4;
  color: var(--color-ink);
}

.kv {
  margin: 0 0 4px;
}

.kv > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 0;
}

.kv dt {
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-ink-faint);
}

.kv dd {
  margin: 0;
  font-size: 15px;
  line-height: 1.7;
  color: var(--color-ink);
}

.note,
.msg {
  margin: 8px 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-ink-faint);
}

.msg {
  color: var(--color-bamboo);
}

.msg.bad {
  color: var(--color-ji);
}

.warn {
  margin: 8px 0;
  font-size: 15px;
  line-height: 1.7;
  color: var(--color-ji);
}

.quote {
  margin: 0 0 6px;
  font-family: var(--font-cn-kai);
  font-size: 15px;
  line-height: 1.7;
  color: var(--color-ink-soft);
}

.line-btn {
  display: block;
  width: 100%;
  margin: 8px 0 0;
  padding: 10px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-card);
  background: none;
  font-family: var(--font-cn-kai);
  font-size: 15px;
  line-height: 1.7;
  text-align: center;
  color: var(--color-ink-soft);
  cursor: pointer;
}

.line-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.as-label input {
  display: none;
}
</style>
