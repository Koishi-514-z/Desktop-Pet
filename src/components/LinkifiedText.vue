<script setup lang="ts">
import { computed } from 'vue'
import { openUrl } from '@/files/api'

const props = defineProps<{ text: string }>()

// 网址结尾常见的中英文标点不算在链接内
const URL_REGEX = /https?:\/\/[^\s<>"'，。；、）」】]+[^\s<>"'，。；、）」】.,;:!?)\]]/g

const parts = computed(() => {
  const result: { text: string, url?: string }[] = []
  let last = 0
  for (const match of props.text.matchAll(URL_REGEX)) {
    if (match.index > last) result.push({ text: props.text.slice(last, match.index) })
    result.push({ text: match[0], url: match[0] })
    last = match.index + match[0].length
  }
  if (last < props.text.length) result.push({ text: props.text.slice(last) })
  return result
})

function open(url: string) {
  openUrl(url).catch((error) => console.warn('[link] 打开链接失败：', error))
}
</script>

<template>
  <span>
    <template v-for="(part, index) in parts" :key="index">
      <a v-if="part.url" :href="part.url" class="link" :title="`用浏览器打开 ${part.url}`" @click.prevent="open(part.url)">{{ part.text }}</a>
      <template v-else>{{ part.text }}</template>
    </template>
  </span>
</template>

<style scoped>
.link {
  color: #9ec2ff;
  text-decoration: none;
  word-break: break-all;
  border-bottom: 1px solid rgb(158 194 255 / 35%);
  transition:
    color 0.15s,
    border-color 0.15s;
}

.link:hover {
  color: #c4dbff;
  border-bottom-color: #c4dbff;
}
</style>
