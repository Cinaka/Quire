<script setup lang="ts">
import { computed } from "vue"
import type { NotebookReadPort } from "@/repo"
import { projectNotebookContent } from "@/shared/notebookContent"
import type { Entry } from "@/shared/types"
import NotebookNode from "./NotebookNode.vue"
import "@/styles/notebook.css"
import "@/styles/notebook-fonts.css"
const props = defineProps<{ entry: Entry; port: NotebookReadPort; tagNames?: Record<string, string> }>()
const projection = computed(() => projectNotebookContent(props.entry.content))
</script>

<template>
  <article class="notebook-paper" :aria-label="`${entry.entryDate} ${entry.title.trim() || '无题'}`">
    <header>
      <time class="notebook-meta" :datetime="entry.entryDate">{{ entry.entryDate }}</time>
      <h2 class="notebook-title">{{ entry.title.trim() || "无题" }}</h2>
      <div class="notebook-meta">
        <span v-if="entry.mood">{{ entry.mood }}</span>
        <span v-if="entry.weather">{{ entry.weather }}</span>
        <span v-for="id in entry.tagIds" :key="id">#{{ tagNames?.[id] ?? "本机标签未就绪" }}</span>
      </div>
    </header>
    <aside v-if="projection.warnings.length" class="notebook-warning notebook-notice" role="note">
      <p v-for="warning in projection.warnings" :key="warning">{{ warning }}</p>
    </aside>
    <div class="notebook-body">
      <template v-if="entry.content">
        <NotebookNode v-for="(node, index) in projection.nodes" :key="index" :node="node" :entry="entry" :port="port" />
      </template>
      <p v-else class="notebook-notice">此简正文留白。</p>
    </div>
  </article>
</template>
