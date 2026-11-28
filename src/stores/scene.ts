import { invoke } from '@tauri-apps/api/core'
import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import { isTauri } from '@/composables/desktop'
import type { PanelSize } from '@/utils/panel-resize'

export interface BoxState {
  visible: boolean
  position: { x: number, y: number }
}

// 对话框、待办框、设置框的默认尺寸与最小尺寸（拖动边、角可以调整，窗口较小时自动收缩）
export const DEFAULT_CHAT_PANEL_SIZE: PanelSize = { width: 760, height: 880 }
export const MIN_CHAT_PANEL_SIZE: PanelSize = { width: 420, height: 460 }
export const DEFAULT_TASK_PANEL_SIZE: PanelSize = { width: 360, height: 540 }
export const MIN_TASK_PANEL_SIZE: PanelSize = { width: 340, height: 320 }
export const DEFAULT_SETTING_PANEL_SIZE: PanelSize = { width: 640, height: 720 }
export const MIN_SETTING_PANEL_SIZE: PanelSize = { width: 480, height: 400 }

// 显示 / 隐藏桌宠窗口的默认快捷键（格式见 ShortcutRecorder）
export const DEFAULT_TOGGLE_SHORTCUT = 'Ctrl+Alt+KeyS'

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

  // 显示 / 隐藏桌宠窗口的全局快捷键，效果与托盘菜单的「显示 / 隐藏」相同（窗口隐藏时也能用）
  const toggleShortcut = useLocalStorage('settings/scene/toggleShortcut', DEFAULT_TOGGLE_SHORTCUT)
  // 注册快捷键失败时的错误信息（如已被其他程序或桌宠的其他功能占用）
  const toggleShortcutError = ref('')

  // 快捷键由 Rust 端注册（浏览器中没有全局快捷键）；改变时注销旧的、注册新的
  if (isTauri) {
    watch(toggleShortcut, async (shortcut) => {
      try {
        await invoke('set_toggle_shortcut', { shortcut })
        toggleShortcutError.value = ''
      }
      catch (error) {
        toggleShortcutError.value = String(error)
      }
    }, { immediate: true })
  }

  // 对话框、待办框、设置框的尺寸：用户拖动边、角调整后记住
  const chatPanelSize = useLocalStorage<PanelSize>('settings/scene/chatPanelSize', { ...DEFAULT_CHAT_PANEL_SIZE }, { mergeDefaults: true })
  const taskPanelSize = useLocalStorage<PanelSize>('settings/scene/taskPanelSize', { ...DEFAULT_TASK_PANEL_SIZE }, { mergeDefaults: true })
  const settingPanelSize = useLocalStorage<PanelSize>('settings/scene/settingPanelSize', { ...DEFAULT_SETTING_PANEL_SIZE }, { mergeDefaults: true })

  const interactiveAreaState = ref<BoxState>({ visible: false, position: { x: 0, y: 0 } })
  const settingBoxState = ref<BoxState>({ visible: false, position: { x: 0, y: 0 } })
  // 待办面板只记是否打开（位置由面板自己管理）
  const taskPanelState = ref({ visible: false })

  function resetToDefault() {
    resolution.value = 3
    maxFPS.value = 180
    playbackVolume.value = 1
    motionVolume.value = 1
    showSubtitle.value = true
    subtitleHideDelay.value = 5
    toggleShortcut.value = DEFAULT_TOGGLE_SHORTCUT
    chatPanelSize.value = { ...DEFAULT_CHAT_PANEL_SIZE }
    taskPanelSize.value = { ...DEFAULT_TASK_PANEL_SIZE }
    settingPanelSize.value = { ...DEFAULT_SETTING_PANEL_SIZE }
  }

  return {
    resolution,
    maxFPS,
    playbackVolume,
    motionVolume,
    showSubtitle,
    subtitleHideDelay,
    toggleShortcut,
    toggleShortcutError,
    chatPanelSize,
    taskPanelSize,
    settingPanelSize,
    interactiveAreaState,
    settingBoxState,
    taskPanelState,
    resetToDefault,
  }
})