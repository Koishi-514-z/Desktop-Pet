import { describe, expect, it } from 'vitest'
import { cropAround, diffBounds } from '@/live2d/image-diff'

/** width × height 的透明画面，fill 中的像素涂成白色不透明 */
function frame(width: number, height: number, fill: (x: number, y: number) => boolean = () => false) {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (fill(x, y)) pixels.set([255, 255, 255, 255], (y * width + x) * 4)
    }
  }
  return pixels
}

describe('找出表情变化的区域', () => {
  it('只有变化的区域；变化太少（看不出区别）时为空', () => {
    const base = frame(100, 80)
    const changed = frame(100, 80, (x, y) => x >= 20 && x < 40 && y >= 10 && y < 15)
    expect(diffBounds(base, changed, 100, 80)).toEqual({ x: 20, y: 10, width: 20, height: 5 })
    expect(diffBounds(base, changed, 100, 80, { minPixels: 101 })).toBeNull()
    expect(diffBounds(base, base, 100, 80)).toBeNull()
  })

  it('细微的颜色差别不算变化', () => {
    const base = frame(10, 10, () => true)
    const slightly = base.map((value, index) => (index % 4 === 3 ? value : value - 20))
    expect(diffBounds(base, slightly, 10, 10, { minPixels: 1 })).toBeNull()
  })

  it('截取的范围四周留出空间，至少一定大小，不超出画面', () => {
    // 区域在画面中间：每边留出最长边的 0.6 倍
    expect(cropAround({ x: 400, y: 300, width: 100, height: 50 }, 1000, 1000, { minSize: 0 }))
      .toEqual({ x: 340, y: 240, width: 220, height: 170 })
    // 太小时放大到最小尺寸
    expect(cropAround({ x: 500, y: 500, width: 10, height: 10 }, 1000, 1000)).toMatchObject({ width: 240, height: 240 })
    // 靠近边缘时挪回画面内
    expect(cropAround({ x: 0, y: 0, width: 100, height: 100 }, 1000, 1000)).toMatchObject({ x: 0, y: 0, width: 240, height: 240 })
    // 比画面还大时截取整个画面
    expect(cropAround({ x: 0, y: 0, width: 300, height: 300 }, 300, 200)).toEqual({ x: 0, y: 0, width: 300, height: 200 })
  })
})
