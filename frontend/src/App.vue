<script setup lang="ts">
import { RouterLink, RouterView } from "vue-router"
</script>

<template>
  <div class="min-h-full flex flex-col">
    <main class="flex-1"><RouterView /></main>
    <nav class="flex justify-around border-t border-bamboo/20 py-2 md:hidden">
      <RouterLink to="/">今日</RouterLink>
      <RouterLink to="/list">简册</RouterLink>
      <RouterLink to="/schedules">预简</RouterLink>
      <RouterLink to="/settings">设置</RouterLink>
    </nav>
  </div>
</template>
