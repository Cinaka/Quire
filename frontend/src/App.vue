<script setup lang="ts">
import { onMounted, onBeforeUnmount } from "vue"
import { installScheduleSyncRuntime } from "@/api/scheduleSyncRuntime"
import { RouterLink, RouterView } from "vue-router"
let stopScheduleRuntime: (() => void) | undefined
onMounted(() => { stopScheduleRuntime = installScheduleSyncRuntime() })
onBeforeUnmount(() => stopScheduleRuntime?.())
</script>

<template>
  <div class="min-h-full flex flex-col">
    <main class="flex-1"><RouterView /></main>
    <nav class="flex justify-around border-t border-bamboo/20 py-2 md:hidden">
      <RouterLink to="/">今简</RouterLink>
      <RouterLink to="/list">简册</RouterLink>
      <RouterLink to="/schedules" title="预简 / 待刻（本机优先，云笺可单独启用本次会话同步）">预简</RouterLink>
      <RouterLink to="/sync">云笺</RouterLink>
      <RouterLink to="/settings">设置</RouterLink>
    </nav>
  </div>
</template>

