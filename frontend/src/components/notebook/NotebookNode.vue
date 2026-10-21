<script setup lang="ts">
import type { NotebookNode as Node } from "@/shared/notebookContent"
import type { Entry } from "@/shared/types"
import type { NotebookReadPort } from "@/repo"
import NotebookImage from "./NotebookImage.vue"
defineProps<{ node: Node; entry: Entry; port: NotebookReadPort }>()
</script>

<template>
  <template v-if="node.kind === 'text'">{{ node.text }}</template>
  <NotebookImage v-else-if="node.kind === 'image'" :entry="entry" :port="port" :media-id="node.mediaId" :alt="node.alt" :title="node.title" />
  <span v-else-if="node.kind === 'notice'" class="notebook-notice">{{ node.text }}</span>
  <br v-else-if="node.tag === 'br'" />
  <component :is="node.tag" v-else :start="node.tag === 'ol' ? node.start : undefined">
    <NotebookNode v-for="(child, index) in node.children" :key="index" :node="child" :entry="entry" :port="port" />
  </component>
</template>
