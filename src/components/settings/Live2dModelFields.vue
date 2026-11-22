<script lang="ts">
// 模型详情页与添加页共用的可编辑字段
export interface Live2dModelForm {
  name: string
  description: string
  url: string
  image: string
  positionX: number
  positionY: number
  scale: number
}
</script>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const form = defineModel<Live2dModelForm>({ required: true })

// 预览图加载失败时显示占位图
const imageError = ref(false)
watch(
  () => form.value.image,
  () => (imageError.value = false),
)
const showImage = computed(() => form.value.image.trim() !== '' && !imageError.value)
</script>

<template>
  <div class="model-hero">
    <div class="hero-thumb">
      <img v-if="showImage" :src="form.image" alt="预览图" @error="imageError = true" />
      <div v-else class="thumb-placeholder">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" />
        </svg>
        <span>{{ form.image ? '预览图加载失败' : '无预览图' }}</span>
      </div>
      <slot name="badge" />
    </div>

    <div class="hero-fields">
      <input v-model="form.name" class="name-input" type="text" placeholder="模型名称" />
      <input v-model="form.description" class="desc-input" type="text" placeholder="添加一句描述（可选）" />

      <label class="path-field">
        <span class="path-label">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
            <path d="M14 3v5h5" />
          </svg>
          模型文件
        </span>
        <input v-model="form.url" type="text" placeholder=".../model.model3.json" />
      </label>

      <label class="path-field">
        <span class="path-label">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <circle cx="9" cy="10" r="2" />
            <path d="M21 16l-5-5-9 9" />
          </svg>
          预览图
        </span>
        <input v-model="form.image" type="text" placeholder=".../image.png" />
      </label>
    </div>
  </div>

  <section class="transform-panel">
    <div class="transform-head">
      <span class="block-title">位置与缩放</span>
      <span class="block-hint">也可以直接在桌面上拖拽、滚轮缩放模型</span>
    </div>
    <div class="transform-inputs">
      <label class="tf-input">
        <span class="tf-key">X</span>
        <input v-model.number="form.positionX" type="number" step="1" />
        <span class="tf-unit">px</span>
      </label>
      <label class="tf-input">
        <span class="tf-key">Y</span>
        <input v-model.number="form.positionY" type="number" step="1" />
        <span class="tf-unit">px</span>
      </label>
      <label class="tf-input">
        <span class="tf-key">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
          </svg>
        </span>
        <input v-model.number="form.scale" type="number" min="0" step="0.05" />
        <span class="tf-unit">×</span>
      </label>
    </div>
  </section>
</template>

<style scoped src="../../css/settings/Live2dSetting.css"></style>
