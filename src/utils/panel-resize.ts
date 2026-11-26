/**
 * 拖动面板的边、角调整大小（如对话框）：根据拖动的距离算出新的位置与尺寸。
 * 拖动左边、上边时，对边保持不动；尺寸不小于最小值，拖动的边不超出窗口（四周留出 margin）
 */

// 拖动的是哪条边或哪个角：n 上、s 下、e 右、w 左
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
export const RESIZE_EDGES: ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

export interface PanelSize {
  width: number
  height: number
}

export interface PanelRect extends PanelSize {
  x: number
  y: number
}

export interface ResizeLimits {
  min: PanelSize
  // 窗口（视口）大小
  bounds: PanelSize
  // 与窗口边缘至少保持的距离
  margin: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/** 从 start 开始拖动 edge，鼠标移动了 (dx, dy) 后面板的位置与尺寸 */
export function resizePanel(start: PanelRect, edge: ResizeEdge, dx: number, dy: number, limits: ResizeLimits): PanelRect {
  const { min, bounds, margin } = limits
  const right = start.x + start.width
  const bottom = start.y + start.height
  const maxWidth = bounds.width - margin * 2
  const maxHeight = bounds.height - margin * 2
  let { x, y, width, height } = start

  if (edge.includes('e')) {
    width = clamp(start.width + dx, min.width, Math.min(maxWidth, bounds.width - margin - start.x))
  }
  else if (edge.includes('w')) {
    width = clamp(start.width - dx, min.width, Math.min(maxWidth, right - margin))
    x = right - width
  }

  if (edge.includes('s')) {
    height = clamp(start.height + dy, min.height, Math.min(maxHeight, bounds.height - margin - start.y))
  }
  else if (edge.includes('n')) {
    height = clamp(start.height - dy, min.height, Math.min(maxHeight, bottom - margin))
    y = bottom - height
  }

  return { x, y, width, height }
}

// 面板与窗口边缘至少保持的距离（与面板 CSS 中的 max-width / max-height 一致）
export const PANEL_MARGIN = 16

// 右下角那一列悬浮按钮（待办、设置、对话）占的位置：面板默认摆放、恢复默认尺寸时让出来
export const FLOATING_BUTTONS_GAP = { right: 88, bottom: 24 }

/** 当前窗口（视口）的大小 */
export function viewportSize(): PanelSize {
  return { width: window.innerWidth, height: window.innerHeight }
}

export interface PanelPosition {
  x: number
  y: number
}

/**
 * 把面板放进窗口：右边、下边至少留出 gap（如让出右下角的悬浮按钮），左边、上边至少留出 PANEL_MARGIN。
 * 传入 { x: Infinity, y: Infinity } 时即为默认摆放：贴着右下角（留出 gap）
 */
export function keepPanelInView(position: PanelPosition, size: PanelSize, bounds: PanelSize, gap: { right: number, bottom: number }): PanelPosition {
  return {
    x: Math.max(PANEL_MARGIN, Math.min(position.x, bounds.width - size.width - gap.right)),
    y: Math.max(PANEL_MARGIN, Math.min(position.y, bounds.height - size.height - gap.bottom)),
  }
}

/** 把保存的尺寸限制在窗口能放下的范围内（如换到了更小的屏幕） */
export function fitPanelSize(size: PanelSize, limits: ResizeLimits): PanelSize {
  const { min, bounds, margin } = limits
  return {
    width: clamp(size.width, min.width, bounds.width - margin * 2),
    height: clamp(size.height, min.height, bounds.height - margin * 2),
  }
}
