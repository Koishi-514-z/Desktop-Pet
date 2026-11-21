<script setup lang="ts">
import { useLive2dStore } from '@/stores/live2d'

const emit = defineEmits<{
  select: [id: string]
  add: []
}>()

const live2dStore = useLive2dStore()

function isCurrent(id: string) {
  return live2dStore.currentModelId === id
}

function setCurrent(id: string) {
  live2dStore.switchModel(id)
}

function remove(id: string) {
  live2dStore.removeModel(id)
}
</script>

<template>
  <div class="live2d-main">
    <div class="live2d-main-header">
      <h3 class="section-title group-title">
        全局设置
      </h3>
      <button class="field-action" @click="live2dStore.resetGlobalOptionsToDefault()">
        恢复默认全局设置
      </button>
    </div>

    <section class="live2d-section">
      <h3 class="section-title">
        视线跟随
      </h3>
      <div class="toggle-row">
        <span>启用视线跟随</span>
        <input v-model="live2dStore.useFocus" type="checkbox" class="toggle">
      </div>
      <template v-if="live2dStore.useFocus">
        <div class="field-grid">
          <div class="field">
            <label>静止超时 (ms)</label>
            <input v-model.number="live2dStore.eyeFocusTimeout" type="number" min="0" step="500">
          </div>
          <div class="field">
            <label>跟随灵敏度</label>
            <input v-model.number="live2dStore.eyeFocusSensitivity" type="number" min="0" step="0.5">
          </div>
          <div class="field">
            <label>空闲缓动系数</label>
            <input v-model.number="live2dStore.focusLerpFactorIdle" type="number" min="0" max="1" step="0.001">
          </div>
          <div class="field">
            <label>跟随缓动系数</label>
            <input v-model.number="live2dStore.focusLerpFactorMouse" type="number" min="0" max="1" step="0.001">
          </div>
        </div>
      </template>
    </section>

    <section class="live2d-section">
      <h3 class="section-title">
        口型同步
      </h3>
      <div class="toggle-row">
        <span>启用口型同步</span>
        <input v-model="live2dStore.useLipSync" type="checkbox" class="toggle">
      </div>
      <template v-if="live2dStore.useLipSync">
        <div class="field-grid">
          <div class="field">
            <label>音量放大倍数</label>
            <input v-model.number="live2dStore.lipSyncGain" type="number" min="0" step="0.5">
          </div>
        </div>
      </template>
    </section>

    <section class="live2d-section">
      <h3 class="section-title">
        鼠标交互
      </h3>
      <div class="toggle-row">
        <span>拖拽移动模型</span>
        <input v-model="live2dStore.useDrag" type="checkbox" class="toggle">
      </div>
      <div class="toggle-row">
        <span>滚轮缩放模型</span>
        <input v-model="live2dStore.useScroll" type="checkbox" class="toggle">
      </div>
      <template v-if="live2dStore.useScroll">
        <div class="field-grid">
          <div class="field">
            <label>缩放步长</label>
            <input v-model.number="live2dStore.scrollScaleStep" type="number" min="0" step="0.01">
          </div>
          <div class="field">
            <label>最小缩放</label>
            <input v-model.number="live2dStore.minScale" type="number" min="0" step="0.1">
          </div>
          <div class="field">
            <label>最大缩放</label>
            <input v-model.number="live2dStore.maxScale" type="number" min="0" step="0.1">
          </div>
        </div>
      </template>
      <div class="toggle-row">
        <span>点击触发动作</span>
        <input v-model="live2dStore.useHit" type="checkbox" class="toggle">
      </div>
    </section>

    <section class="live2d-section">
      <h3 class="section-title group-title model-section-title">
        模型设置
      </h3>
      <div class="model-cards">
        <div
          v-for="model in live2dStore.models"
          :key="model.id"
          class="model-card"
          :class="{ current: isCurrent(model.id) }"
          @click="emit('select', model.id)"
        >
          <div class="card-header">
            <span class="card-name">{{ model.name }}</span>
          </div>
          <div class="card-thumbnail">
            <img v-if="model.image" :src="model.image" :alt="model.name">
            <span v-else class="card-thumbnail-placeholder">无预览图</span>
          </div>
          <div class="card-actions">
            <button
              class="card-action"
              :class="{ active: isCurrent(model.id) }"
              @click.stop="setCurrent(model.id)"
            >
              {{ isCurrent(model.id) ? '使用中' : '设为当前' }}
            </button>
            <button class="card-remove" title="删除" :disabled="live2dStore.isDefaultModel(model.id)" @click.stop="remove(model.id)">
              ×
            </button>
          </div>
        </div>

        <div class="model-card add-card" @click="emit('add')">
          <span class="add-icon">+</span>
          <span>添加模型</span>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped src="../../css/settings/Live2dSetting.css"></style>
