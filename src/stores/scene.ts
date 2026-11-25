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
  // 语音播放音量（0~1），即桌宠说话时的音量
  const playbackVolume = useLocalStorage('settings/scene/playbackVolume', 1)
  // 动作音量（0~1），即播放动作时模型自带的声音（model3.json 中动作的 Sound）的音量
  const motionVolume = useLocalStorage('settings/scene/motionVolume', 1)
  // 是否在屏幕底部显示字幕（桌宠说话时显示）
  const showSubtitle = useLocalStorage('settings/scene/showSubtitle', true)
  // 桌宠说完后，字幕再保留多少秒后自动隐藏
  const subtitleHideDelay = useLocalStorage('settings/scene/subtitleHideDelay', 5)

  const interactiveAreaState = ref<BoxState>({ visible: false, position: { x: 0, y: 0 } })
  const settingBoxState = ref<BoxState>({ visible: false, position: { x: 0, y: 0 } })

  function resetToDefault() {
    resolution.value = 3
    maxFPS.value = 180
    playbackVolume.value = 1
    motionVolume.value = 1
    showSubtitle.value = true
    subtitleHideDelay.value = 5
  }

  return {
    resolution,
    maxFPS,
    playbackVolume,
    motionVolume,
    showSubtitle,
    subtitleHideDelay,
    interactiveAreaState,
    settingBoxState,
    resetToDefault,
  }
})