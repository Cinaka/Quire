<template>
  <div class="almanac-card">
    <div class="flex items-start justify-between gap-4">
      <div>
        <div class="lunar-date">{{ almanac.lunarShort }}</div>
        <div class="meta">
          {{ almanac.ganZhi }}（{{ almanac.zodiac }}）年 · {{ almanac.zhiXing }}日
        </div>
      </div>
      <div v-if="almanac.jieQi || almanac.festivals.length" class="badge">
        {{ almanac.jieQi ?? almanac.festivals[0] }}
      </div>
    </div>

    <div class="divider" />

    <div class="grid grid-cols-2 gap-3">
      <div>
        <span class="tag tag-yi">宜</span>
        <div class="taboo-list">
          <span v-for="w in yiText" :key="w">{{ w }}</span>
        </div>
      </div>
      <div>
        <span class="tag tag-ji">忌</span>
        <div class="taboo-list">
          <span v-for="w in jiText" :key="w">{{ w }}</span>
        </div>
      </div>
    </div>

    <p v-if="almanac.restricted" class="restricted">今日馀事勿取，宜守常</p>

    <button class="more" type="button" @click="expanded = !expanded">
      {{ expanded ? "收起" : "完整黄历" }}
    </button>

    <div v-if="expanded" class="raw">
      <div class="fact">
        <span class="k">宜</span>
        <span class="v">{{ almanac.yi.join(" ") || "—" }}</span>
      </div>
      <div class="fact" style="margin-top: 12px">
        <span class="k">忌</span>
        <span class="v">{{ almanac.ji.join(" ") || "—" }}</span>
      </div>

      <div class="divider" />

      <div class="facts">
        <div class="fact">
          <span class="k">五行</span>
          <span class="v">{{ almanac.naYin }} {{ almanac.zhiXing }}执位</span>
        </div>
        <div class="fact">
          <span class="k">冲煞</span>
          <span class="v">{{ almanac.chong }} {{ almanac.sha }}</span>
        </div>
        <div class="fact">
          <span class="k">星宿</span>
          <span class="v">{{ almanac.xiu }}－{{ almanac.xiuLuck }}</span>
        </div>
        <div class="fact">
          <span class="k">胎神</span>
          <span class="v">{{ almanac.taiShen }}</span>
        </div>
      </div>

      <div class="fact fact-full">
        <span class="k">彭祖</span>
        <div class="pengzu-grid">
          <span v-for="line in almanac.pengZu" :key="line">{{ line }}</span>
        </div>
      </div>

      <div class="divider" />

      <div class="k">时辰</div>
      <div class="hours">
        <span
          v-for="h in almanac.hours"
          :key="h.zhi"
          class="hour"
          :class="h.lucky ? 'hour-good' : 'hour-bad'"
          :title="`${h.range} ${h.god}`"
        >
          {{ h.zhi }}<i>{{ h.lucky ? "吉" : "凶" }}</i>
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue"

import type { AlmanacDay } from "@/shared/almanac"

const props = defineProps<{ almanac: AlmanacDay }>()

const expanded = ref(false)

// 词典全不命中时退回值星基调。tone 形如 "宜断旧"，宜字由标签渲染，这里剥掉
const yiText = computed(() =>
  props.almanac.yiBrief.length ? props.almanac.yiBrief : [props.almanac.tone.replace(/^宜/, "")],
)
const jiText = computed(() =>
  props.almanac.jiBrief.length ? props.almanac.jiBrief : ["躁进"],
)
</script>

<style scoped>
.almanac-card {
  /* 整张卡片——从农历日期到时辰吉凶——统一走楷体 */
  font-family: var(--font-cn-kai);
  padding: 20px;
  border-radius: var(--radius-card);
  background: var(--color-paper-deep);
  border: 1px solid color-mix(in srgb, var(--color-ink) 8%, transparent);
}

.lunar-date {
  font-family: var(--font-cn-kai);
  font-size: 28px;
  line-height: 1.2;
  color: var(--color-ink);
}

.meta {
  margin-top: 4px;
  font-size: 15px;
  color: var(--color-ink-soft);
}

.badge {
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 14px;
  color: var(--color-bamboo);
  background: var(--color-bamboo-wash);
  white-space: nowrap;
}

.divider {
  height: 1px;
  margin: 16px 0;
  background: color-mix(in srgb, var(--color-ink) 8%, transparent);
}

.tag {
  display: inline-block;
  width: 24px;
  height: 24px;
  line-height: 24px;
  text-align: center;
  border-radius: 4px;
  font-size: 15px;
  color: #fff;
}

.tag-yi {
  background: var(--color-yi);
}

.tag-ji {
  background: var(--color-ji);
}

.taboo-list {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-family: var(--font-cn-kai);
  font-size: 18px;
  color: var(--color-ink);
}

.restricted {
  margin: 14px 0 0;
  font-family: var(--font-cn-kai);
  font-size: 15px;
  color: var(--color-ji);
}

.more {
  margin-top: 16px;
  padding: 0;
  border: none;
  background: none;
  font-size: 14px;
  color: var(--color-ink-faint);
  cursor: pointer;
}

.raw {
  margin-top: 12px;
  font-size: 14px;
  line-height: 1.8;
  color: var(--color-ink-soft);
}

.raw p {
  margin: 0;
}

.raw b {
  margin-right: 6px;
  color: var(--color-ink);
}

/* 二列键值区：PC 上一行两项，窄屏自动变单列 */
.facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 20px;
  margin-top: 4px;
}

.fact {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.fact-full {
  margin-top: 12px;
}

/* 标题比正文大：楷体下靠加粗拉开层级不可靠（很多楷体无粗体，会被伪粗抹掉笔画），改靠字号 */
.k {
  font-size: 17px;
  color: var(--color-ink);
  letter-spacing: 2px;
}

.v {
  font-size: 14px;
  color: var(--color-ink-soft);
  word-break: break-all;
}

.pengzu-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 3px 20px;
  color: var(--color-ink-soft);
}

@media (max-width: 480px) {
  .facts,
  .pengzu-grid {
    grid-template-columns: 1fr;
  }
}

.hours {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 6px;
  margin-top: 8px;
}

.hour {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 2px;
  padding: 5px 0;
  border-radius: 6px;
  font-family: var(--font-cn-kai);
  font-size: 16px;
  cursor: default;
}

.hour i {
  font-style: normal;
  font-size: 13px;
  opacity: 0.75;
}

.hour-good {
  color: var(--color-yi);
  background: color-mix(in srgb, var(--color-yi) 12%, transparent);
}

.hour-bad {
  color: var(--color-ji);
  background: color-mix(in srgb, var(--color-ji) 10%, transparent);
}
</style>
