<script setup lang="ts">
import { useSceneStore } from '@/stores/scene'

const sceneStore = useSceneStore()
</script>

<template>
  <div class="scene-setting">
    <div class="scene-setting-header">
      <h3 class="section-title group-title">
        场景设置
      </h3>
      <button class="field-action" @click="sceneStore.resetToDefault()">
        恢复默认
      </button>
    </div>

    <section class="scene-section">
      <h3 class="section-title">
        渲染
      </h3>
      <div class="field-grid">
        <div class="field">
          <label>渲染分辨率</label>
          <input v-model.number="sceneStore.resolution" type="number" min="1" max="4" step="0.5">
        </div>
        <div class="field">
          <label>最大帧率 (FPS)</label>
          <input v-model.number="sceneStore.maxFPS" type="number" min="1" max="240" step="1">
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped src="../../css/settings/Live2dSetting.css"></style>

<style scoped>
.scene-setting {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.scene-setting-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgb(255 255 255 / 12%);
}

.scene-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
