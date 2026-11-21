<script setup lang="ts">
import { computed } from 'vue'
import { useSceneStore } from '@/stores/scene'

const sceneStore = useSceneStore()

// 以 0~100 的百分比形式编辑播放音量（存储值为 0~1）
const volumePercent = computed({
  get: () => Math.round(sceneStore.playbackVolume * 100),
  set: (value: number) => {
    sceneStore.playbackVolume = Math.min(Math.max(value, 0), 100) / 100
  },
})
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

    <section class="scene-section">
      <h3 class="section-title">
        音频
      </h3>
      <div class="field">
        <label>播放音量</label>
        <div class="field-row volume-row">
          <input v-model.number="volumePercent" type="range" min="0" max="100" step="1">
          <span class="volume-value">{{ volumePercent }}%</span>
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

.volume-row {
  align-items: center;
}

.volume-row input[type='range'] {
  padding: 0;
  background: transparent;
  border: none;
  accent-color: #fff;
}

.volume-value {
  min-width: 40px;
  font-size: 12px;
  color: rgb(255 255 255 / 80%);
  text-align: right;
}
</style>
