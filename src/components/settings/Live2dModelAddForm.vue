<script setup lang="ts">
import type { Live2dModelForm } from './Live2dModelFields.vue'
import { computed, ref } from 'vue'
import { useLive2dStore } from '@/stores/live2d'
import Live2dModelFields from './Live2dModelFields.vue'

const emit = defineEmits<{ back: []; created: [id: string] }>()

const live2dStore = useLive2dStore()

const form = ref<Live2dModelForm>({
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
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
      </button>
      <span class="detail-title">添加模型</span>
    </header>

    <Live2dModelFields v-model="form">
      <template #badge>
        <span class="thumb-badge">新模型</span>
      </template>
    </Live2dModelFields>

    <p class="tip">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5M12 8h.01" />
      </svg>
      <span>
        模型文件需指向 Cubism 3/4 的 <code>.model3.json</code>，可放在
        <code>public/assets/live2d/models</code> 目录下。表情、动作等信息会在模型首次加载后自动识别。
      </span>
    </p>

    <footer class="detail-actions">
      <span class="spacer" />
      <button class="action-button" @click="emit('back')">取消</button>
      <button class="action-button primary" :disabled="!canSubmit" @click="submit">添加</button>
    </footer>
  </div>
</template>

<style scoped src="../../css/settings/Live2dSetting.css"></style>
