import type { ImageRef } from '@/utils/images'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { IMAGE_SKILL_ID, MAX_IMAGES } from '@/agent/skills/image'
import { SELECTION_SKILL_ID } from '@/agent/skills/selection'
import { isTauri, useDesktopCursor } from '@/composables/desktop'
import { useAgentStore } from '@/stores/agent'
import type { AudioRef } from '@/utils/audios'
import { addAudio, deleteAudios, MAX_AUDIOS } from '@/utils/audios'
import { addImage, deleteImages } from '@/utils/images'

// 划词：获取选中的文字（或图片）；截图：框选屏幕区域
export type CaptureKind = 'selection' | 'screenshot'

// 默认快捷键。不建议只用 Alt 作修饰键：Windows 上松开 Alt 可能激活应用的菜单栏，导致复制失败
export const DEFAULT_SHORTCUTS: Record<CaptureKind, string> = {
  selection: 'Ctrl+Alt+KeyQ',
  screenshot: 'Ctrl+Alt+KeyW',
}

// 各功能依赖的技能
const REQUIRED_SKILLS: Record<CaptureKind, string> = {
  selection: SELECTION_SKILL_ID,
  screenshot: IMAGE_SKILL_ID,
}

interface CaptureResult {
  kind: CaptureKind
  text: string | null
  // PNG 图片的 data URL
  image: string | null
  error: string | null
}

export interface CaptureToolbarState {
  visible: boolean
  // 工具栏锚点（快捷键按下时的鼠标位置，CSS 像素）
  x: number
  y: number
  // 获取到的文字或图片（data URL），二者都为空时展示 message
  text: string
  image: string
  message: string
}

// 划词与截图：通过全局快捷键获取其他应用中的内容，在鼠标旁弹出工具栏
export const useCaptureStore = defineStore('capture', () => {
  const agentStore = useAgentStore()
  const cursor = useDesktopCursor()

  const shortcuts = {
    selection: useLocalStorage('settings/selection/shortcut', DEFAULT_SHORTCUTS.selection),
    screenshot: useLocalStorage('settings/screenshot/shortcut', DEFAULT_SHORTCUTS.screenshot),
  }
  // 注册快捷键失败时的错误信息
  const shortcutErrors = ref<Record<CaptureKind, string>>({ selection: '', screenshot: '' })

  const toolbar = ref<CaptureToolbarState>({ visible: false, x: 0, y: 0, text: '', image: '', message: '' })

  // 附加到下一条消息上的划词内容与图片（对话面板输入框上方展示）
  const pendingQuote = ref('')
  const pendingImages = ref<ImageRef[]>([])
  const pendingAudios = ref<AudioRef[]>([])

  // 对应的技能可用时才注册快捷键
  const active = computed<Record<CaptureKind, boolean>>(() => {
    const ids = agentStore.activeSkills.map((skill) => skill.id)
    return { selection: ids.includes(REQUIRED_SKILLS.selection), screenshot: ids.includes(REQUIRED_SKILLS.screenshot) }
  })

  async function applyShortcut(kind: CaptureKind) {
    try {
      await invoke('set_capture_shortcut', { kind, shortcut: active.value[kind] ? shortcuts[kind].value : null })
      shortcutErrors.value[kind] = ''
    }
    catch (error) {
      shortcutErrors.value[kind] = String(error)
    }
  }

  function showToolbar(state: Pick<CaptureToolbarState, 'text' | 'image' | 'message'>) {
    // 没有全局鼠标坐标时（如刚启动）显示在屏幕中央
    const { x, y } = cursor.value ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    toolbar.value = { visible: true, x, y, ...state }
  }

  function hideToolbar() {
    toolbar.value.visible = false
  }

  function onCaptured({ kind, text, image, error }: CaptureResult) {
    if (text?.trim()) {
      showToolbar({ text: text.trim(), image: '', message: '' })
    }
    else if (image) {
      showToolbar({ text: '', image, message: '' })
    }
    else {
      const fallback = kind === 'selection' ? '没有获取到选中的内容，请先选中文字再按快捷键' : '没有获取到截图'
      showToolbar({ text: '', image: '', message: error ?? fallback })
    }
  }

  // ===== 待发送的图片 =====

  async function addPendingImage(source: Blob | string) {
    if (pendingImages.value.length >= MAX_IMAGES) throw new Error(`一次最多发送 ${MAX_IMAGES} 张图片`)
    const image = await addImage(source)
    pendingImages.value.push(image)
    return image
  }

  function removePendingImage(id: string) {
    pendingImages.value = pendingImages.value.filter((image) => image.id !== id)
    deleteImages([id]).catch(() => {})
  }

  // ===== 待发送的音频 =====

  async function addPendingAudio(file: File) {
    if (pendingAudios.value.length >= MAX_AUDIOS) throw new Error(`一次最多发送 ${MAX_AUDIOS} 个音频`)
    const audio = await addAudio(file)
    pendingAudios.value.push(audio)
    return audio
  }

  function removePendingAudio(id: string) {
    pendingAudios.value = pendingAudios.value.filter((audio) => audio.id !== id)
    deleteAudios([id]).catch(() => {})
  }

  // 取出待发送的附件（发送消息时调用）
  function takePending() {
    const attachments = { quote: pendingQuote.value, images: pendingImages.value, audios: pendingAudios.value }
    pendingQuote.value = ''
    pendingImages.value = []
    pendingAudios.value = []
    return attachments
  }

  // 调起系统截图工具，返回截图的 data URL；取消时返回 null
  async function takeScreenshot(): Promise<string | null> {
    if (!isTauri) throw new Error('截图需要在桌面应用中使用，可以直接把图片粘贴或拖到对话框中')
    return invoke<string | null>('take_screenshot')
  }

  let initialized = false
  async function init() {
    if (!isTauri || initialized) return
    initialized = true

    await listen<CaptureResult>('capture-result', ({ payload }) => onCaptured(payload))

    // 先注销再注册，避免两个快捷键互换时误报冲突
    watch([active, shortcuts.selection, shortcuts.screenshot], async () => {
      await invoke('set_capture_shortcut', { kind: 'selection', shortcut: null }).catch(() => {})
      await invoke('set_capture_shortcut', { kind: 'screenshot', shortcut: null }).catch(() => {})
      await applyShortcut('selection')
      await applyShortcut('screenshot')
    }, { immediate: true })
  }

  return {
    shortcuts,
    shortcutErrors,
    toolbar,
    pendingQuote,
    pendingImages,
    pendingAudios,
    active,
    init,
    showToolbar,
    hideToolbar,
    addPendingImage,
    removePendingImage,
    addPendingAudio,
    removePendingAudio,
    takePending,
    takeScreenshot,
  }
})
