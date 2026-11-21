<script setup lang="ts">
import { computed, ref } from 'vue'
import { useLive2dStore } from '@/stores/live2d'

const emit = defineEmits<{ back: [], created: [id: string] }>()

const live2dStore = useLive2dStore()

const form = ref({
  name: '',
  description: '',
  url: '',
  image: '',
  positionX: 800,
  positionY: 500,
  scale: 0.3,
})

const canSubmit = computed(() => form.value.name.trim() !== '' && form.value.url.trim() !== '')

function submit() {
  if (!canSubmit.value) return

  const id = live2dStore.addModel({
    id: '',
    name: form.value.name,
    description: form.value.description,
    url: form.value.url,
    image: form.value.image,
    position: { x: form.value.positionX, y: form.value.positionY },
    scale: form.value.scale,
    defaultExpression: { name: '' },
  })
  emit('created', id)
}
</script>

<template>
  <div class="model-detail">
    <header class="detail-header">
      <button class="back-button" title="返回" @click="emit('back')">
        ←
      </button>
      <span class="detail-title">添加模型</span>
    </header>

    <div class="field">
      <label>名称</label>
      <input v-model="form.name" type="text" placeholder="模型名称">
    </div>

    <div class="field">
      <label>描述</label>
      <input v-model="form.description" type="text" placeholder="可选">
    </div>

    <div class="field">
      <label>模型文件地址 (model3.json)</label>
      <input v-model="form.url" type="text" placeholder="/assets/live2d/models/.../model.model3.json">
    </div>

    <div class="field">
      <label>缩略图地址</label>
      <div class="field-row">
        <input v-model="form.image" type="text" placeholder="/assets/live2d/models/.../image.png">
        <div class="thumbnail-preview">
          <img v-if="form.image" :src="form.image" alt="预览">
          <span v-else class="card-thumbnail-placeholder">无预览图</span>
        </div>
      </div>
    </div>

    <div class="field-grid">
      <div class="field">
        <label>位置 X</label>
        <input v-model.number="form.positionX" type="number" step="1">
      </div>
      <div class="field">
        <label>位置 Y</label>
        <input v-model.number="form.positionY" type="number" step="1">
      </div>
      <div class="field">
        <label>缩放</label>
        <input v-model.number="form.scale" type="number" min="0" step="0.05">
      </div>
    </div>

    <div class="detail-actions">
      <button class="action-button" :disabled="!canSubmit" @click="submit">
        添加
      </button>
    </div>
  </div>
</template>

<style scoped src="../../css/settings/Live2dSetting.css"></style>
