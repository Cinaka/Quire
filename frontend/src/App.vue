<script setup lang="ts">
import { RouterLink, RouterView } from "vue-router"
</script>

<template>
  <div class="min-h-full flex flex-col">
    <main class="flex-1"><RouterView /></main>
    <nav class="flex justify-around border-t border-bamboo/20 py-2 md:hidden">
      <RouterLink to="/">今简</RouterLink>
      <RouterLink to="/list">简册</RouterLink>
      <span class="nav-disabled" aria-disabled="true" title="预简（待刻）尚未开放">预简</span>
      <RouterLink to="/sync">云笺</RouterLink>
      <RouterLink to="/settings">设置</RouterLink>
    </nav>
  </div>
</template>

<style scoped>
.nav-disabled {
  color: var(--color-ink-faint);
  cursor: not-allowed;
  user-select: none;
}
</style>
