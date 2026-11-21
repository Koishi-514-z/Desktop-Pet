import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'

export interface BoxState {
  visible: boolean
  position: { x: number, y: number }
}

export const useSceneStore = defineStore('scene', () => {
  const resolution = useLocalStorage('settings/scene/resolution', 3)
  const maxFPS = useLocalStorage('settings/scene/maxFPS', 180)

  const interactiveAreaState = ref<BoxState>({ visible: false, position: { x: 0, y: 0 } })
  const settingBoxState = ref<BoxState>({ visible: false, position: { x: 0, y: 0 } })

  function resetToDefault() {
    resolution.value = 3
    maxFPS.value = 180
  }

  return {
    resolution,
    maxFPS,
    interactiveAreaState,
    settingBoxState,
    resetToDefault,
  }
})