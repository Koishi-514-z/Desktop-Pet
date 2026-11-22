import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { SELECTION_SKILL_ID } from '@/agent/skills/selection'
import { isTauri, useDesktopCursor } from '@/composables/desktop'
import { useAgentStore } from '@/stores/agent'

// 默认划词快捷键。不建议只用 Alt 作修饰键：Windows 上松开 Alt 可能激活应用的菜单栏，导致复制失败
export const DEFAULT_SELECTION_SHORTCUT = 'Ctrl+Alt+KeyQ'

interface CapturedSelection {
  text: string | null
  error: string | null
}

export interface SelectionToolbarState {
  visible: boolean
  // 工具栏锚点（划词时的鼠标位置，CSS 像素）
  x: number
  y: number
  // 划词获取到的文字，为空时展示 message
  text: string
  message: string
}

// 划词：通过全局快捷键获取其他应用中选中的文字，在鼠标旁弹出工具栏
export const useSelectionStore = defineStore('selection', () => {
  const agentStore = useAgentStore()
  const cursor = useDesktopCursor()

  const shortcut = useLocalStorage('settings/selection/shortcut', DEFAULT_SELECTION_SHORTCUT)
  // 注册快捷键失败时的错误信息
  const shortcutError = ref('')

  const toolbar = ref<SelectionToolbarState>({ visible: false, x: 0, y: 0, text: '', message: '' })
  // 「提问」：附加到下一条消息上的划词内容
  const pendingQuote = ref('')

  // 划词技能可用时才注册快捷键
  const active = computed(() => agentStore.activeSkills.some((skill) => skill.id === SELECTION_SKILL_ID))

  async function applyShortcut() {
    try {
      await invoke('set_selection_shortcut', { shortcut: active.value ? shortcut.value : null })
      shortcutError.value = ''
    }
    catch (error) {
      shortcutError.value = String(error)
    }
  }

  function showToolbar(state: Omit<SelectionToolbarState, 'visible' | 'x' | 'y'>) {
    // 没有全局鼠标坐标时（如刚启动）显示在屏幕中央
    const { x, y } = cursor.value ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    toolbar.value = { visible: true, x, y, ...state }
  }

  function hideToolbar() {
    toolbar.value.visible = false
  }

  let initialized = false
  async function init() {
    if (!isTauri || initialized) return
    initialized = true

    await listen<CapturedSelection>('selection-captured', ({ payload }) => {
      if (payload.text?.trim()) {
        showToolbar({ text: payload.text.trim(), message: '' })
      }
      else {
        showToolbar({ text: '', message: payload.error ?? '没有获取到选中的文字，请先选中文字再按快捷键' })
      }
    })

    watch([active, shortcut], applyShortcut, { immediate: true })
  }

  return {
    shortcut,
    shortcutError,
    toolbar,
    pendingQuote,
    active,
    init,
    showToolbar,
    hideToolbar,
  }
})
