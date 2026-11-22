<script setup lang="ts">
import { useLive2dStore } from '@/stores/live2d'
import { getInitial } from '@/utils/avatar'

const emit = defineEmits<{
  select: [id: string]
  add: []
}>()

const live2dStore = useLive2dStore()

type ToggleKey = 'useFocus' | 'useLipSync' | 'useDrag' | 'useScroll' | 'useHit'
type ParamKey =
  | 'eyeFocusTimeout'
  | 'eyeFocusSensitivity'
  | 'focusLerpFactorIdle'
  | 'focusLerpFactorMouse'
  | 'lipSyncGain'
  | 'scrollScaleStep'
  | 'minScale'
  | 'maxScale'

interface FeatureParam {
  key: ParamKey
  label: string
  unit?: string
  min?: number
  max?: number
  step: number
}

interface Feature {
  key: ToggleKey
  title: string
  description: string
  // 图标的 SVG path 列表与配色
  icon: string[]
  tone: string
  params: FeatureParam[]
}

const features: Feature[] = [
  {
    key: 'useFocus',
    title: '视线跟随',
    description: '模型的视线会跟随桌面上的鼠标移动',
    icon: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6z'],
    tone: 'cyan',
    params: [
      { key: 'eyeFocusTimeout', label: '静止超时', unit: 'ms', min: 0, step: 500 },
      { key: 'eyeFocusSensitivity', label: '跟随灵敏度', min: 0, step: 0.5 },
      { key: 'focusLerpFactorIdle', label: '空闲缓动系数', min: 0, max: 1, step: 0.001 },
      { key: 'focusLerpFactorMouse', label: '跟随缓动系数', min: 0, max: 1, step: 0.001 },
    ],
  },
  {
    key: 'useLipSync',
    title: '口型同步',
    description: '说话时根据语音音量驱动嘴部开合',
    icon: ['M3 10v4M7 7v10M11 4v16M15 7v10M19 10v4'],
    tone: 'pink',
    params: [{ key: 'lipSyncGain', label: '音量放大倍数', unit: '×', min: 0, step: 0.5 }],
  },
  {
    key: 'useDrag',
    title: '拖拽移动',
    description: '按住模型即可在桌面上拖动位置',
    icon: [
      'M12 3v18M3 12h18',
      'M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3',
    ],
    tone: 'amber',
    params: [],
  },
  {
    key: 'useScroll',
    title: '滚轮缩放',
    description: '在模型上滚动鼠标滚轮调整大小',
    icon: ['M11 4a7 7 0 1 0 0 14 7 7 0 1 0 0-14z', 'M20 20l-4-4M11 8v6M8 11h6'],
    tone: 'violet',
    params: [
      { key: 'scrollScaleStep', label: '缩放步长', min: 0, step: 0.01 },
      { key: 'minScale', label: '最小缩放', unit: '×', min: 0, step: 0.1 },
      { key: 'maxScale', label: '最大缩放', unit: '×', min: 0, step: 0.1 },
    ],
  },
  {
    key: 'useHit',
    title: '点击互动',
    description: '点击模型的不同部位触发对应动作',
    icon: ['M9 9l10 4-4.5 1.5L13 19z', 'M5 5l2 2M9 3v3M3 9h3'],
    tone: 'green',
    params: [],
  },
]

function isCurrent(id: string) {
  return live2dStore.currentModelId === id
}
</script>

<template>
  <div class="live2d-main">
    <!-- 模型库 -->
    <section class="block">
      <div class="block-head">
        <h3 class="block-title">
          模型库
          <span class="block-count">{{ live2dStore.models.length }}</span>
        </h3>
        <span class="block-hint">点击卡片编辑模型</span>
      </div>

      <div class="gallery">
        <div
          v-for="model in live2dStore.models"
          :key="model.id"
          class="poster"
          :class="{ current: isCurrent(model.id) }"
          @click="emit('select', model.id)"
        >
          <div class="poster-image">
            <img v-if="model.image" :src="model.image" :alt="model.name" />
            <span v-else class="poster-initial">{{ getInitial(model.name) }}</span>
          </div>

          <span v-if="isCurrent(model.id)" class="poster-ribbon">
            <i class="ribbon-dot" />
            使用中
          </span>

          <button
            v-if="!live2dStore.isDefaultModel(model.id)"
            class="poster-remove"
            title="删除"
            @click.stop="live2dStore.removeModel(model.id)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>

          <div class="poster-info">
            <span class="poster-name">{{ model.name }}</span>
            <span v-if="model.description" class="poster-desc">{{ model.description }}</span>
            <button
              v-if="!isCurrent(model.id)"
              class="poster-use"
              @click.stop="live2dStore.switchModel(model.id)"
            >
              换上这个模型
            </button>
          </div>
        </div>

        <button class="poster add-poster" type="button" @click="emit('add')">
          <span class="add-ring">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          </span>
          <span>添加模型</span>
        </button>
      </div>
    </section>

    <!-- 交互行为 -->
    <section class="block">
      <div class="block-head">
        <h3 class="block-title">交互行为</h3>
        <button class="text-button" @click="live2dStore.resetGlobalOptionsToDefault()">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
            <path d="M3 3v5h5" />
          </svg>
          恢复默认
        </button>
      </div>

      <div class="feature-list">
        <div
          v-for="feature in features"
          :key="feature.key"
          class="feature"
          :class="[feature.tone, { on: live2dStore[feature.key] }]"
        >
          <label class="feature-row">
            <span class="feature-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path v-for="d in feature.icon" :key="d" :d="d" />
              </svg>
            </span>
            <span class="feature-text">
              <span class="feature-title">{{ feature.title }}</span>
              <span class="feature-desc">{{ feature.description }}</span>
            </span>
            <span class="switch">
              <input v-model="live2dStore[feature.key]" type="checkbox" />
              <span class="switch-track" />
            </span>
          </label>

          <div
            v-if="feature.params.length > 0 && live2dStore[feature.key]"
            class="feature-params"
          >
            <label v-for="param in feature.params" :key="param.key" class="param">
              <span class="param-label">{{ param.label }}</span>
              <span class="param-input">
                <input
                  v-model.number="live2dStore[param.key]"
                  type="number"
                  :min="param.min"
                  :max="param.max"
                  :step="param.step"
                />
                <span v-if="param.unit" class="param-unit">{{ param.unit }}</span>
              </span>
            </label>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped src="../../css/settings/Live2dSetting.css"></style>
