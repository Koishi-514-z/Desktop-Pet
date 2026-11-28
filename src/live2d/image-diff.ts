import { clamp } from '@/utils/math'

/**
 * 比较两帧画面，找出表情变化的区域，并算出交给视觉模型时截取的范围（见 live2d/snapshot.ts）。
 * 不依赖 Live2D 与 WebGL，可以单独测试
 */

/** 一个像素的颜色或透明度变化超过多少才算变了（0～255） */
const PIXEL_THRESHOLD = 40
/** 变了的像素少于多少时，当作这个表情看不出变化 */
const MIN_CHANGED_PIXELS = 50

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 两帧画面（RGBA）中有变化的区域；变了的像素太少（看不出变化）时返回 null
 */
export function diffBounds(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  width: number,
  height: number,
  options: { threshold?: number, minPixels?: number } = {},
): Bounds | null {
  const { threshold = PIXEL_THRESHOLD, minPixels = MIN_CHANGED_PIXELS } = options
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  let changed = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (
        Math.abs(a[i]! - b[i]!) > threshold
        || Math.abs(a[i + 1]! - b[i + 1]!) > threshold
        || Math.abs(a[i + 2]! - b[i + 2]!) > threshold
        || Math.abs(a[i + 3]! - b[i + 3]!) > threshold
      ) {
        changed++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (changed < minPixels) return null
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

/**
 * 截取的范围：变化的区域四周各留出一些（看得出变化在脸上的哪里），至少 minSize 见方，不超出画面
 */
export function cropAround(bounds: Bounds, canvasWidth: number, canvasHeight: number, options: { margin?: number, minSize?: number } = {}): Bounds {
  const { margin = 0.6, minSize = 240 } = options
  const pad = Math.max(bounds.width, bounds.height) * margin
  const width = Math.round(Math.min(Math.max(bounds.width + pad * 2, minSize), canvasWidth))
  const height = Math.round(Math.min(Math.max(bounds.height + pad * 2, minSize), canvasHeight))
  const centerX = bounds.x + bounds.width / 2
  const centerY = bounds.y + bounds.height / 2
  return {
    x: clamp(Math.round(centerX - width / 2), 0, canvasWidth - width),
    y: clamp(Math.round(centerY - height / 2), 0, canvasHeight - height),
    width,
    height,
  }
}
