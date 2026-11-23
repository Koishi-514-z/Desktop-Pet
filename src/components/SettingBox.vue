<script setup lang="ts">
import { computed, onBeforeUnmount, ref, onMounted } from 'vue'
import { useSceneStore } from '@/stores/scene'
import ProviderSetting from './settings/ProviderSetting.vue'
import Live2dSetting from './settings/Live2dSetting.vue'
import PersonaSetting from './settings/PersonaSetting.vue'
import SceneSetting from './settings/SceneSetting.vue'
import AgentSetting from './settings/AgentSetting.vue'
import MemorySetting from './settings/MemorySetting.vue'

// 设置面板的分类标签
const tabs = [
  { id: 'provider', label: 'Provider' },
  { id: 'live2d', label: 'Live2D 模型' },
  { id: 'persona', label: '人物设定' },
  { id: 'scene', label: '场景' },
  { id: 'agent', label: '技能' },
  { id: 'memory', label: '记忆' },
] as const

type SettingTabId = (typeof tabs)[number]['id']

const sceneStore = useSceneStore()
const state = computed(() => sceneStore.settingBoxState)

// 当前选中的设置分类
const activeTab = ref<SettingTabId>('provider')

// 拖拽状态
const dragging = ref(false)
const dragOffset = ref({ x: 0, y: 0 })

const panelStyle = computed(() => ({
  left: `${state.value.position.x}px`,
  top: `${state.value.position.y}px`,
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

onMounted(() => {
    state.value.position = { x: window.innerWidth - 444 - 440, y: window.innerHeight - 808 }
})

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onDrag)
  window.removeEventListener('pointerup', stopDrag)
})
</script>

<template>
  <button class="settings-toggle-button" :title="state.visible ? '收起设置' : '打开设置'" @click="state.visible = !state.visible">
    {{ state.visible ? '×' : '⚙️' }}
  </button>

  <div v-show="state.visible" class="settings-panel" :style="panelStyle">
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
      </section>
    </div>
  </div>
</template>

<style scoped src="../css/SettingBox.css"></style>
