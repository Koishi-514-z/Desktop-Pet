import { describe, expect, it } from 'vitest'
import { fitPanelSize, keepPanelInView, resizePanel } from '@/utils/panel-resize'

const limits = { min: { width: 420, height: 460 }, bounds: { width: 1600, height: 1000 }, margin: 16 }
const start = { x: 600, y: 100, width: 760, height: 800 }

describe('拖动边、角调整面板大小', () => {
  it('拖右边、下边只改尺寸；拖左边、上边时对边不动', () => {
    expect(resizePanel(start, 'se', 40, 30, limits)).toEqual({ x: 600, y: 100, width: 800, height: 830 })
    expect(resizePanel(start, 'nw', -50, -20, limits)).toEqual({ x: 550, y: 80, width: 810, height: 820 })
    // 拖动单条边时，另一个方向不变
    expect(resizePanel(start, 'e', 40, 999, limits)).toEqual({ x: 600, y: 100, width: 800, height: 800 })
    expect(resizePanel(start, 'n', 999, 50, limits)).toEqual({ x: 600, y: 150, width: 760, height: 750 })
  })

  it('不小于最小尺寸：缩到底后对边仍然不动', () => {
    expect(resizePanel(start, 'w', 600, 0, limits)).toEqual({ x: 940, y: 100, width: 420, height: 800 })
    expect(resizePanel(start, 'se', -600, -600, limits)).toEqual({ x: 600, y: 100, width: 420, height: 460 })
  })

  it('拖动的边不超出窗口（四周留出边距）', () => {
    // 右边最多到 1600 - 16，下边最多到 1000 - 16
    expect(resizePanel(start, 'se', 2000, 2000, limits)).toEqual({ x: 600, y: 100, width: 984, height: 884 })
    // 左边最多到 16，上边最多到 16
    expect(resizePanel(start, 'nw', -2000, -2000, limits)).toEqual({ x: 16, y: 16, width: 1344, height: 884 })
  })

  it('默认贴着右下角摆放并让出悬浮按钮；放不下时挪回窗口内，但左上角不出界', () => {
    const bounds = { width: 1600, height: 1000 }
    const gap = { right: 88, bottom: 24 }
    expect(keepPanelInView({ x: Infinity, y: Infinity }, { width: 760, height: 880 }, bounds, gap)).toEqual({ x: 752, y: 96 })
    // 本来就在窗口内的不动
    expect(keepPanelInView({ x: 100, y: 50 }, { width: 760, height: 880 }, bounds, gap)).toEqual({ x: 100, y: 50 })
    // 变大后右边会挡住悬浮按钮：往左挪
    expect(keepPanelInView({ x: 1092, y: 48 }, { width: 760, height: 880 }, bounds, gap)).toEqual({ x: 752, y: 48 })
    // 窗口比面板还小：贴着左上角
    expect(keepPanelInView({ x: Infinity, y: Infinity }, { width: 760, height: 880 }, { width: 700, height: 600 }, gap)).toEqual({ x: 16, y: 16 })
  })

  it('保存的尺寸比窗口能放下的大时，按窗口收缩；但不小于最小尺寸', () => {
    expect(fitPanelSize({ width: 760, height: 880 }, { ...limits, bounds: { width: 1536, height: 824 } })).toEqual({ width: 760, height: 792 })
    expect(fitPanelSize({ width: 300, height: 300 }, limits)).toEqual({ width: 420, height: 460 })
  })
})
