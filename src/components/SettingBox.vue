<script setup lang="ts">
import type { PanelRect } from '@/utils/panel-resize'
import { computed, onBeforeUnmount, ref, onMounted } from 'vue'
import ResizeHandles from '@/components/ResizeHandles.vue'
import { DEFAULT_SETTING_PANEL_SIZE, MIN_SETTING_PANEL_SIZE, useSceneStore } from '@/stores/scene'
import { FLOATING_BUTTONS_GAP, fitPanelSize, keepPanelInView, PANEL_MARGIN, viewportSize } from '@/utils/panel-resize'
import ProviderSetting from './settings/ProviderSetting.vue'
import Live2dSetting from './settings/Live2dSetting.vue'
import PersonaSetting from './settings/PersonaSetting.vue'
import SceneSetting from './settings/SceneSetting.vue'
import AgentSetting from './settings/AgentSetting.vue'
import MemorySetting from './settings/MemorySetting.vue'
import ToolSetting from './settings/ToolSetting.vue'
import ProactiveSetting from './settings/ProactiveSetting.vue'
import UsageSetting from './settings/UsageSetting.vue'
import FavoriteSetting from './settings/FavoriteSetting.vue'

// 设置面板的分类标签
const tabs = [
  { id: 'provider', label: 'Provider' },
  { id: 'live2d', label: 'Live2D' },
  { id: 'persona', label: 'Persona' },
  { id: 'scene', label: 'Scene' },
  { id: 'agent', label: 'Skills' },
  { id: 'memory', label: 'Memory' },
  { id: 'proactive', label: 'Proactive' },
  { id: 'tools', label: 'Tools' },
  { id: 'usage', label: 'Usage' },
  { id: 'favorites', label: 'Favorites' },
] as const

type SettingTabId = (typeof tabs)[number]['id']

const sceneStore = useSceneStore()
const state = computed(() => sceneStore.settingBoxState)

// 当前选中的设置分类
const activeTab = ref<SettingTabId>('provider')

// 拖拽状态
const dragging = ref(false)
const dragOffset = ref({ x: 0, y: 0 })

// 面板的位置与尺寸（尺寸是用户调整后记住的；窗口较小时 CSS 会再收缩）
const panelStyle = computed(() => ({
  left: `${state.value.position.x}px`,
  top: `${state.value.position.y}px`,
  width: `${sceneStore.settingPanelSize.width}px`,
  height: `${sceneStore.settingPanelSize.height}px`,
}))

function startDrag(event: PointerEvent) {
  dragging.value = true
  dragOffset.value = {
    x: event.clientX - state.value.position.x,
    y: event.clientY - state.value.position.y,
  }
  window.addEventListener('pointermove', onDrag)
  window.addEventListener('pointerup', stopDrag)
}

function onDrag(event: PointerEvent) {
  if (!dragging.value) return
  state.value.position = {
    x: event.clientX - dragOffset.value.x,
    y: event.clientY - dragOffset.value.y,
  }
}

function stopDrag() {
  dragging.value = false
  window.removeEventListener('pointermove', onDrag)
  window.removeEventListener('pointerup', stopDrag)
}

// ===== 拖动边、角调整大小（记住调整后的尺寸，见 ResizeHandles）=====

// 默认摆放时与窗口右边、下边的距离（默认尺寸下与原来的位置一样）
const DEFAULT_PLACEMENT_GAP = { right: 244, bottom: 88 }

function sizeLimits() {
  return { min: MIN_SETTING_PANEL_SIZE, bounds: viewportSize(), margin: PANEL_MARGIN }
}

function applyPanelRect(rect: PanelRect) {
  state.value.position = { x: rect.x, y: rect.y }
  sceneStore.settingPanelSize = { width: rect.width, height: rect.height }
}

// 双击边、角恢复默认尺寸（左上角不动；放不下时往回挪，不挡住右下角的悬浮按钮）
function resetPanelSize() {
  const size = fitPanelSize(DEFAULT_SETTING_PANEL_SIZE, sizeLimits())
  sceneStore.settingPanelSize = size
  state.value.position = keepPanelInView(state.value.position, size, viewportSize(), FLOATING_BUTTONS_GAP)
}

onMounted(() => {
  // 按记住的尺寸摆放；窗口放不下时按收缩后的大小算，标题栏不会跑到窗口外面
  const size = fitPanelSize(sceneStore.settingPanelSize, sizeLimits())
  state.value.position = keepPanelInView({ x: Infinity, y: Infinity }, size, viewportSize(), DEFAULT_PLACEMENT_GAP)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onDrag)
  window.removeEventListener('pointerup', stopDrag)
})
</script>

<template>
  <!-- 外框负责位置与尺寸：调整大小的手柄跨在面板边缘（面板本身裁掉了溢出的内容，手柄放不进去） -->
  <div v-show="state.visible" class="settings-frame" :style="panelStyle">
    <div class="settings-panel">
      <header class="panel-header" @pointerdown="startDrag">
        <span class="panel-title">设置</span>
        <button class="close-button" title="关闭" @click="state.visible = false">
          ×
        </button>
      </header>

      <div class="settings-body">
        <nav class="settings-tabs">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            class="settings-tab"
            :class="{ active: tab.id === activeTab }"
            @click="activeTab = tab.id"
          >
            {{ tab.label }}
          </button>
        </nav>

        <section class="settings-content">
          <ProviderSetting v-if="activeTab === 'provider'" />
          <Live2dSetting v-else-if="activeTab === 'live2d'" />
          <PersonaSetting v-else-if="activeTab === 'persona'" />
          <SceneSetting v-else-if="activeTab === 'scene'" />
          <AgentSetting v-else-if="activeTab === 'agent'" />
          <MemorySetting v-else-if="activeTab === 'memory'" />
          <ProactiveSetting v-else-if="activeTab === 'proactive'" />
          <ToolSetting v-else-if="activeTab === 'tools'" />
          <UsageSetting v-else-if="activeTab === 'usage'" />
          <FavoriteSetting v-else-if="activeTab === 'favorites'" />
        </section>
      </div>
    </div>

    <!-- 拖动边、角调整大小，双击恢复默认尺寸 -->
    <ResizeHandles :min="MIN_SETTING_PANEL_SIZE" @resize="applyPanelRect" @reset="resetPanelSize" />
  </div>
</template>

<style scoped src="../css/SettingBox.css"></style>
