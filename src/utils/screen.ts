import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/composables/desktop'

/** 可以截取的窗口 */
export interface WindowInfo {
  id: number
  title: string
  appName: string
}

function ensureDesktop() {
  if (!isTauri) throw new Error('查看屏幕需要在桌面应用中使用，可以直接把截图粘贴到对话框中')
}

/** 获取截图的目标窗口：用户最近使用的、不属于桌宠的窗口；找不到时返回 null */
export async function getTargetWindow(): Promise<WindowInfo | null> {
  ensureDesktop()
  return invoke<WindowInfo | null>('get_target_window')
}

/** 截取指定窗口，返回 PNG 图片的 data URL */
export async function captureWindow(id: number): Promise<string> {
  ensureDesktop()
  return invoke<string>('capture_window', { id })
}
