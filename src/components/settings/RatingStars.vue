<script setup lang="ts">
import { computed, ref } from 'vue'
import { MAX_RATING } from '@/stores/providers'

const props = defineProps<{ modelValue: number; label?: string }>()
const emit = defineEmits<{ 'update:modelValue': [rating: number] }>()

// 鼠标悬停时预览将要打的分
const hovered = ref(0)
const shown = computed(() => hovered.value || props.modelValue)

// 再次点击当前的分数时清除评分
function rate(value: number) {
  emit('update:modelValue', value === props.modelValue ? 0 : value)
}

function starTitle(value: number) {
  return value === props.modelValue ? '清除评分' : `${value} 星`
}
</script>

<template>
  <!-- 放在可点击的卡片里：点击、按键都不传给卡片，打分时不会顺带选中 -->
  <span
    class="rating-stars"
    :class="{ rated: modelValue > 0 }"
    role="group"
    :aria-label="`${label ?? '评分'}：${modelValue > 0 ? `${modelValue} 星` : '未评分'}`"
    @click.stop
    @keydown.stop
    @mouseleave="hovered = 0"
  >
    <button
      v-for="value in MAX_RATING"
      :key="value"
      type="button"
      class="star"
      :class="{ on: value <= shown, preview: hovered > 0 }"
      :title="starTitle(value)"
      :aria-pressed="value <= modelValue"
      @mouseenter="hovered = value"
      @click="rate(value)"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />
      </svg>
    </button>
  </span>
</template>

<style scoped>
.rating-stars {
  display: inline-flex;
  gap: 1px;
  align-items: center;
}

.star {
  display: flex;
  padding: 1px;
  color: rgb(255 255 255 / 28%);
  cursor: pointer;
  background: transparent;
  border: none;
  border-radius: 4px;
  outline: none;
  transition:
    color 0.15s,
    transform 0.15s;
}

.star svg {
  width: 12px;
  height: 12px;
  fill: currentcolor;
  stroke: none;
}

.star.on {
  color: #ffc857;
}

/* 预览时颜色浅一些，和已经打的分区分开 */
.star.on.preview {
  color: rgb(255 200 87 / 75%);
}

.star:hover {
  transform: scale(1.2);
}

.star:focus-visible {
  box-shadow: 0 0 0 2px rgb(64 158 255 / 60%);
}
</style>
