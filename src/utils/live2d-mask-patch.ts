/**
 * 放宽 pixi-live2d-display(cubism4) 对遮罩数量的限制
 *
 * 库内置的 Cubism 框架只有一张遮罩贴图，按 RGBA 4 个颜色通道 × 每个通道最多 4×4 格划分，
 * 最多容纳 64 个遮罩。超出时多余的遮罩不会被分配通道，渲染时
 * getChannelFlagAsColor(undefined) 返回 undefined，报错
 * "Cannot read properties of undefined (reading 'R')"，模型无法显示。
 *
 * 这里把每个通道的划分改为按数量自动计算的 N×N 网格，并在遮罩较多时增大遮罩贴图尺寸，
 * 避免每格分辨率过低导致遮罩边缘模糊。遮罩数量在 64 以内的模型仍走库原本的逻辑。
 */
import * as Cubism4 from 'pixi-live2d-display/cubism4'

const COLOR_CHANNEL_COUNT = 4
// 库原本支持的最大遮罩数：4 个通道 × 4×4 格
const ORIGINAL_MAX_MASKS = COLOR_CHANNEL_COUNT * 16
// 库默认的遮罩贴图边长为 256，此时 3×3 格时每格约 85 像素，以此作为每格的目标分辨率
const TARGET_CELL_SIZE = 256 / 3
const MAX_MASK_BUFFER_SIZE = 2048

interface LayoutBounds { x: number, y: number, width: number, height: number }
interface ClippingContext { _layoutChannelNo: number, _layoutBounds: LayoutBounds }
interface ClippingManager {
  _clippingMaskBufferSize: number
  _clippingContextListForMask: ClippingContext[]
  initialize(...args: unknown[]): void
  setupLayoutBounds(usingClipCount: number): void
}

/** 每个通道需要容纳 count 个遮罩时的网格边长 */
function gridSizeFor(count: number) {
  return Math.ceil(Math.sqrt(count))
}

let patched = false

export function patchLive2dMaskLimit() {
  if (patched) return
  patched = true

  const ClippingManager = (Cubism4 as unknown as Record<string, { prototype: ClippingManager }>)
    .CubismClippingManager_WebGL
  if (!ClippingManager) {
    console.warn('未找到 CubismClippingManager_WebGL，跳过遮罩数量补丁')
    return
  }
  const proto = ClippingManager.prototype
  const originalInitialize = proto.initialize
  const originalSetupLayoutBounds = proto.setupLayoutBounds

  // 遮罩贴图在第一次渲染时才按 _clippingMaskBufferSize 创建，在初始化后按遮罩数量调大即可生效
  proto.initialize = function (this: ClippingManager, ...args: unknown[]) {
    originalInitialize.apply(this, args)

    const maskCount = this._clippingContextListForMask.length
    if (maskCount <= ORIGINAL_MAX_MASKS) return

    const grid = gridSizeFor(Math.ceil(maskCount / COLOR_CHANNEL_COUNT))
    const wanted = 2 ** Math.ceil(Math.log2(grid * TARGET_CELL_SIZE))
    this._clippingMaskBufferSize = Math.min(Math.max(this._clippingMaskBufferSize, wanted), MAX_MASK_BUFFER_SIZE)
  }

  proto.setupLayoutBounds = function (this: ClippingManager, usingClipCount: number) {
    if (usingClipCount <= ORIGINAL_MAX_MASKS) {
      originalSetupLayoutBounds.call(this, usingClipCount)
      return
    }

    // 与原实现一致：遮罩尽量平均分配到 4 个通道，再在每个通道内按网格排布
    const div = Math.floor(usingClipCount / COLOR_CHANNEL_COUNT)
    const mod = usingClipCount % COLOR_CHANNEL_COUNT
    let curClipIndex = 0

    for (let channelNo = 0; channelNo < COLOR_CHANNEL_COUNT; channelNo++) {
      const layoutCount = div + (channelNo < mod ? 1 : 0)
      const grid = gridSizeFor(layoutCount)

      for (let i = 0; i < layoutCount; i++) {
        const cc = this._clippingContextListForMask[curClipIndex++]
        if (!cc) return
        cc._layoutChannelNo = channelNo
        cc._layoutBounds.x = (i % grid) / grid
        cc._layoutBounds.y = Math.floor(i / grid) / grid
        cc._layoutBounds.width = 1 / grid
        cc._layoutBounds.height = 1 / grid
      }
    }
  }
}
