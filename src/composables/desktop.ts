import { ref } from 'vue'
import { cursorPosition, getCurrentWindow } from '@tauri-apps/api/window'

/**
 * 桌面窗口（Tauri）相关逻辑
 *
 * 桌宠窗口铺满整个屏幕工作区且背景透明，因此需要实现「鼠标穿透」：
 * 鼠标位于透明区域时让点击落到下方的其他应用上，只有位于模型的不透明像素或 UI 面板上时才响应。
 *
 * 开启穿透后网页收不到任何鼠标事件，所以改为轮询全局鼠标坐标，自行判断当前位置是否需要响应。
 * 全局鼠标坐标同时用于让模型视线跟随整个桌面上的鼠标。
 */

// 是否运行在 Tauri 窗口中（浏览器中运行时，以下逻辑全部跳过）
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

// 轮询鼠标位置的间隔（毫秒）
const POLL_INTERVAL = 30

// 全局鼠标在页面中的坐标（CSS 像素），仅在 Tauri 中更新；鼠标未移动时不会触发变化
const cursor = ref<{ x: number, y: number } | null>(null)

// 判断某点是否落在模型的不透明区域上，由 Live2D 组件注册
let modelHitTester: ((x: number, y: number) => boolean) | null = null

export function setModelHitTester(tester: ((x: number, y: number) => boolean) | null) {
  modelHitTester = tester
}

export function useDesktopCursor() {
  return cursor
}

// 标记为「可穿透」的元素：页面根容器与 Live2D 画布。鼠标位于这些元素上时，只有命中模型才响应
export const PASSTHROUGH_ATTR = 'data-passthrough'

function isPassthroughElement(el: Element | null) {
  return !el || el === document.documentElement || el === document.body || el.hasAttribute(PASSTHROUGH_ATTR)
}

let started = false

export async function initDesktopWindow() {
  if (!isTauri || started) return
  started = true

  const win = getCurrentWindow()

  // 窗口内容区在屏幕上的位置与缩放比例，用于把全局物理坐标换算为页面 CSS 坐标
  let origin = await win.innerPosition()
  let scaleFactor = await win.scaleFactor()
  const refreshGeometry = async () => {
    origin = await win.innerPosition()
    scaleFactor = await win.scaleFactor()
  }
  await win.onMoved(refreshGeometry)
  await win.onResized(refreshGeometry)
  await win.onScaleChanged(refreshGeometry)

  // 按下鼠标期间（如拖拽模型、拖动面板）保持响应，避免拖出模型范围时突然穿透而中断拖拽
  let pointerHeld = false
  window.addEventListener('pointerdown', () => { pointerHeld = true }, true)
  window.addEventListener('pointerup', () => { pointerHeld = false }, true)
  window.addEventListener('blur', () => { pointerHeld = false })

  // 生产环境下屏蔽 WebView 自带的右键菜单（刷新、检查等）
  if (import.meta.env.PROD) {
    window.addEventListener('contextmenu', event => event.preventDefault())
  }

  let ignoring: boolean | null = null
  let polling = false

  async function setIgnore(ignore: boolean) {
    if (ignoring === ignore) return
    ignoring = ignore
    await win.setIgnoreCursorEvents(ignore)
  }

  async function poll() {
    if (polling) return
    polling = true
    try {
      const position = await cursorPosition()
      const x = (position.x - origin.x) / scaleFactor
      const y = (position.y - origin.y) / scaleFactor

      if (!cursor.value || cursor.value.x !== x || cursor.value.y !== y) {
        cursor.value = { x, y }
      }

      const inside = x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight
      let interactive = false
      if (pointerHeld) {
        interactive = true
      }
      else if (inside) {
        const el = document.elementFromPoint(x, y)
        interactive = isPassthroughElement(el) ? (modelHitTester?.(x, y) ?? false) : true
      }

      await setIgnore(!interactive)
    }
    catch (error) {
      console.error(error)
    }
    finally {
      polling = false
    }
  }

  setInterval(poll, POLL_INTERVAL)
}
