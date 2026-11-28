import * as PIXI from 'pixi.js'
import { Live2DModel } from 'pixi-live2d-display/cubism4'
import { patchLive2dMaskLimit } from '@/utils/live2d-mask-patch'
import type { Bounds } from '@/live2d/image-diff'
import { cropAround, diffBounds } from '@/live2d/image-diff'
import { patchLive2dPhysics } from '@/utils/live2d-physics-patch'

/**
 * 在不显示的画布上渲染模型的每个表情，生成「平时｜这个表情」左右对比的图片，交给视觉模型判断情绪（见 live2d/auto-tag.ts）。
 *
 * - 关掉眨眼、呼吸、物理摆动与待机动作，模型保持默认的姿势，每张图只有表情不同；
 * - 和平时的样子逐像素比较，找出变化的区域（通常就是脸），只截取这一块，全身模型的脸也足够清楚；
 * - 看不出变化的表情（如隐藏水印、改变某个看不见的参数）不生成图片，不用交给模型。
 */

/** 渲染画面的长边（像素） */
const RENDER_SIZE = 1200
/** 推进模型时间的步长（毫秒） */
const FRAME_MS = 1000 / 30
/** 切换表情后等多久再截图：新表情完全淡入、上一个完全淡出（默认各 1 秒） */
const SETTLE_MS = 1600
/** 不存在的待机动作组：不播放待机动作，模型保持默认的姿势 */
const NO_IDLE_GROUP = '__auto_tag_no_idle__'
/** 截取时变化的区域四周各留出多少（变化区域长边的倍数） */
const CROP_MARGIN = 0.75
/** 截取的范围至少是画面长边的多少 */
const CROP_MIN_RATIO = 0.3
/** 对比图中每一半的高度（像素）：截取的区域较小时放大，最多放大到 2 倍 */
const OUTPUT_HEIGHT = 360
const OUTPUT_GAP = 16
const LABEL_HEIGHT = 28

/** 左边平时、右边这个表情，截取同一块区域并排放在白底上（透明背景对部分视觉模型来说是黑色） */
function composeComparison(baseline: HTMLCanvasElement, expression: HTMLCanvasElement, crop: Bounds): string {
  const scale = Math.min(2, OUTPUT_HEIGHT / crop.height)
  const width = Math.round(crop.width * scale)
  const height = Math.round(crop.height * scale)

  const canvas = document.createElement('canvas')
  canvas.width = width * 2 + OUTPUT_GAP
  canvas.height = height + LABEL_HEIGHT
  const context = canvas.getContext('2d')!
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = '#333'
  context.font = '16px sans-serif'
  context.fillText('平时', 8, 20)
  context.fillText('这个表情', width + OUTPUT_GAP + 8, 20)
  context.drawImage(baseline, crop.x, crop.y, crop.width, crop.height, 0, LABEL_HEIGHT, width, height)
  context.drawImage(expression, crop.x, crop.y, crop.width, crop.height, width + OUTPUT_GAP, LABEL_HEIGHT, width, height)
  return canvas.toDataURL('image/jpeg', 0.9)
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('已取消', 'AbortError')
}

export interface ExpressionSnapshot {
  name: string
  /** 平时与这个表情左右并排的对比图（JPEG data URL）；看不出变化时为空字符串 */
  image: string
}

export interface SnapshotOptions {
  signal?: AbortSignal
  /** 每渲染完一个表情调用一次 */
  onProgress?: (done: number, total: number) => void
  /**
   * 结束时是否保留模型的贴图：桌面上正在显示同一个模型时，贴图是共用的（PIXI 按地址缓存），不能销毁。
   * 结束时才判断，期间换了模型也不会出错
   */
  keepTextures?: () => boolean
}

/** 依次渲染模型的这些表情，返回每个表情的对比图 */
export async function renderExpressionSnapshots(url: string, names: string[], options: SnapshotOptions = {}): Promise<ExpressionSnapshot[]> {
  const { signal, onProgress, keepTextures } = options
  // 与桌面上的渲染组件相同的兼容处理（重复调用时不会重复处理）
  patchLive2dMaskLimit()
  patchLive2dPhysics()

  const renderer = new PIXI.Renderer({ width: 1, height: 1, backgroundAlpha: 0, antialias: true, preserveDrawingBuffer: true })
  const loseContext = renderer.gl.getExtension('WEBGL_lose_context')
  const stage = new PIXI.Container()
  let model: Live2DModel | null = null

  try {
    model = await Live2DModel.from(url, { autoInteract: false, autoUpdate: false, idleMotionGroup: NO_IDLE_GROUP })
    throwIfAborted(signal)
    const internal = model.internalModel
    // 关掉眨眼、呼吸与物理摆动（库在这些部件不存在时会跳过）
    Object.assign(internal, { eyeBlink: undefined, breath: undefined, physics: undefined })

    // 画面按模型的比例，长边 RENDER_SIZE
    const scale = RENDER_SIZE / Math.max(internal.width, internal.height)
    const viewWidth = Math.round(internal.width * scale)
    const viewHeight = Math.round(internal.height * scale)
    renderer.resize(viewWidth, viewHeight)
    model.scale.set(scale)
    stage.addChild(model as unknown as PIXI.DisplayObject)

    // 只推进模型的参数（表情淡入淡出），不渲染；截图时才渲染一次
    let elapsed = 0
    const advance = (ms: number) => {
      for (let time = 0; time < ms; time += FRAME_MS) {
        elapsed += FRAME_MS
        internal.update(FRAME_MS, elapsed)
      }
    }
    const capture = () => {
      renderer.render(stage)
      const canvas = document.createElement('canvas')
      canvas.width = viewWidth
      canvas.height = viewHeight
      const context = canvas.getContext('2d', { willReadFrequently: true })!
      context.drawImage(renderer.view as HTMLCanvasElement, 0, 0)
      return { canvas, pixels: context.getImageData(0, 0, viewWidth, viewHeight).data }
    }

    advance(SETTLE_MS)
    const baseline = capture()
    // 变化的区域很小时（如头上冒出一个生气的符号），截取的范围也要够大，把脸一起截进来
    const cropOptions = { margin: CROP_MARGIN, minSize: Math.round(Math.max(viewWidth, viewHeight) * CROP_MIN_RATIO) }

    const snapshots: ExpressionSnapshot[] = []
    for (const [index, name] of names.entries()) {
      throwIfAborted(signal)
      await model.expression(name)
      advance(SETTLE_MS)
      const frame = capture()
      const changed = diffBounds(baseline.pixels, frame.pixels, viewWidth, viewHeight)
      snapshots.push({
        name,
        image: changed ? composeComparison(baseline.canvas, frame.canvas, cropAround(changed, viewWidth, viewHeight, cropOptions)) : '',
      })
      onProgress?.(index + 1, names.length)
      // 让出主线程，界面上的进度与桌宠的动画能跟上
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    return snapshots
  }
  finally {
    if (model) {
      stage.removeChild(model as unknown as PIXI.DisplayObject)
      const keep = keepTextures?.() ?? false
      model.destroy({ children: true, texture: !keep, baseTexture: !keep })
    }
    renderer.destroy(true)
    loseContext?.loseContext()
  }
}
