<script setup lang="ts">
/**
 * Live2D 模型渲染组件
 * 基于 pixi.js + pixi-live2d-display(cubism4) 实现
 *
 * 已启用的渲染/交互特性：
 * - 模型加载、纹理渲染、透明背景
 * - 自动待机动作循环、眨眼、呼吸、物理摆动（由内部 Ticker 自动驱动）
 * - 视线跟随鼠标 (focus)
 * - 点击/拖拽命中检测，触发对应动作组 (hit area -> motion)
 * - 表情切换 (expression)
 * - 鼠标拖拽移动模型、滚轮缩放模型
 * - 自适应窗口大小变化
 * - 与 Pinia store 双向同步（位置、缩放、可用动作/表情/碰撞区域列表）
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as PIXI from 'pixi.js'
import { Live2DModel, MotionPriority, Cubism4ModelSettings, Cubism4InternalModel, InternalModel } from 'pixi-live2d-display/cubism4'
import { useLive2dStore, defaultModels, type Live2dMotion } from '@/stores/live2d'
import { useLive2DEyeFocus } from '@/composables/animation'
import { clamp, randInt } from '@/utils/math'
import { useAudioStore } from '@/stores/audio'
import { useSceneStore } from '@/stores/scene'

type CubismModel = Cubism4InternalModel['coreModel']

// 让 pixi-live2d-display 使用 PIXI 的 Ticker 自动驱动模型更新
// （眨眼、呼吸、物理、待机动作等都依赖这个心跳）
Live2DModel.registerTicker(PIXI.Ticker)

// 为模型贴图开启 mipmap，缩小显示时通过多级纹理采样减少模糊/锯齿
PIXI.settings.MIPMAP_TEXTURES = PIXI.MIPMAP_MODES.ON

const live2dStore = useLive2dStore()
const audioStore = useAudioStore()
const sceneStore = useSceneStore()

// 容器与 PIXI 应用实例
const containerRef = ref<HTMLDivElement>()
const app = ref<PIXI.Application | null>(null)
const model = ref<Live2DModel | null>(null)

// 模型按窗口自适应后的基础缩放比例
const baseScale = ref<number>(1)

// 拖拽状态
const dragging = ref<boolean>(false)
const dragOffset = ref<{ x: number, y: number }>({ x: 0, y: 0 })

const localCurrentMotion = ref<{ group: string, index: number }>({ group: 'Idle', index: 0 })

const moveCursorTimestamp = ref(Date.now())

const eyeFocus = useLive2DEyeFocus()

// 实时记录鼠标在画布坐标系中的位置，供每帧的视线跟随逻辑使用
const pointer = ref<{ x: number, y: number }>({ x: 0, y: 0 })

/**
 * 根据画布尺寸与模型原始尺寸，计算让模型完整显示的基础缩放
 */
function fitModelToCanvas() {
  if (!app.value || !model.value) return

  const { width: viewW, height: viewH } = app.value.renderer
  const { width: modelW, height: modelH } = model.value
  const { x: modelScaleX, y: modelScaleY } = model.value.scale

  // 排除模型自身 scale 的影响，得到模型的初始尺寸
  const baseModelW = modelW / modelScaleX
  const baseModelH = modelH / modelScaleY

  // 取宽高比中较小的一个，保证模型完整显示在画布内
  baseScale.value = Math.min(viewW / baseModelW, viewH / baseModelH)

  applyTransform()
}

/**
 * 将 live2dStore 中保存的 scale / position 应用到模型上
 */
function applyTransform() {
  if (!app.value || !model.value) return

  const finalScale = baseScale.value * live2dStore.scale
  model.value.scale.set(finalScale)

  model.value.position.set(live2dStore.position.x, live2dStore.position.y)
}

/**
 * 从模型设置中读取可用动作组、表情、碰撞区域，写入 live2dStore 供 UI 选择
 */
function syncModelMeta() {
  if (!model.value) return

  const motionManager = model.value.internalModel.motionManager

  // 动作列表
  const motions: Live2dMotion[] = []
  for (const [group, defs] of Object.entries(motionManager.definitions)) {
    defs?.forEach((motion: any, index: number) => {
      motions.push({
        group,
        index,
        fileName: motion.File,
        tags: motion.Tags,
      })
    })
  }
  live2dStore.availableMotions = motions

  // 表情列表
  const expressionDefs = motionManager.expressionManager?.definitions ?? []
  live2dStore.availableExpressions = expressionDefs.map((def) => ({
    name: def.Name,
    fileName: def.File,
    tags: def.Tags,
  }))

  // 碰撞区域列表，附带 model.json 中自定义的 Motion 字段（点击该区域触发的动作组）
  const settings = model.value.internalModel.settings as Cubism4ModelSettings
  const rawHitAreas = (settings as any).json?.HitAreas
  live2dStore.availableHitAreas = rawHitAreas.map((area: any) => ({
    name: area.Name,
    id: area.Id,
    motion: area.Motion,
  }))
}

/**
 * 播放指定动作
 */
async function playMotion(group: string, index?: number, priority = MotionPriority.NORMAL) {
  if (!model.value) return
  console.log("playMotion", group, index)
  await model.value.motion(group, index, priority)
}

/**
 * 切换表情
 */
async function playExpression(name: string) {
  if (!model.value) return
  console.log("playExpression", name)
	await model.value.expression(name)
}

/**
 * 处理模型 "hit" 事件：根据命中的碰撞区域名称，
 * 在 model.json 的 HitAreas 配置中找到对应的动作组并播放
 */
function handleHit(hitAreaNames: string[]) {
  if (!model.value || hitAreaNames.length === 0 || !live2dStore.useHit) return

  const hitAreas = live2dStore.availableHitAreas.filter((a) => hitAreaNames.includes(a.name) && a.motion && live2dStore.motionMaps.get(a.motion)?.length)
  if (hitAreas.length === 0) return

  const randomIndex = randInt(0, hitAreas.length - 1)
  live2dStore.playMotion(hitAreas[randomIndex]!.motion!)
}

/**
 * 鼠标拖拽：按下模型时记录偏移，移动时更新位置并写入 live2dStore
 */
function onPointerDown(event: PIXI.InteractionEvent) {
  if (!model.value || !app.value) return
  if (!live2dStore.useDrag) return
  if (!model.value.getBounds().contains(event.data.global.x, event.data.global.y)) return

  dragging.value = true
  dragOffset.value = {
    x: event.data.global.x - model.value.position.x,
    y: event.data.global.y - model.value.position.y,
  }
}

function onPointerMove(event: PIXI.InteractionEvent) {
  if (!model.value || !app.value) return

  // 记录最新鼠标位置，是否跟随由每帧的 onTick 统一判断
  pointer.value = { x: event.data.global.x, y: event.data.global.y }
  moveCursorTimestamp.value = Date.now()

  if (!dragging.value) return

  const newX = event.data.global.x - dragOffset.value.x
  const newY = event.data.global.y - dragOffset.value.y

  model.value.position.set(newX, newY)
  live2dStore.position = {
    x: newX,
    y: newY,
  }
}

function onPointerUp() {
  dragging.value = false
}

/**
 * 鼠标滚轮缩放模型，仅在鼠标位于模型范围内时生效，缩放结果写入 live2dStore 以便持久化
 */
function onWheel(event: WheelEvent) {
  if (!model.value) return
  if (!live2dStore.useScroll) return
  if (!model.value.getBounds().contains(event.offsetX, event.offsetY)) return

  event.preventDefault()
  const delta = event.deltaY > 0 ? -live2dStore.scrollScaleStep : live2dStore.scrollScaleStep
  const next = live2dStore.scale + delta
  live2dStore.scale = Math.min(Math.max(next, live2dStore.minScale), live2dStore.maxScale)
}

/**
 * 每帧执行
 */
function onTick() {
  if (!app.value || !model.value) return

  const internalModel = model.value.internalModel as InternalModel
  const motionState = model.value.internalModel.motionManager.state
  const isMotionPlaying = motionState.currentPriority !== MotionPriority.NONE

  // 视线跟随：当前没有动作播放且开启该功能时，眼球跟随鼠标 / 自动扫视
  if (live2dStore.useFocus && !isMotionPlaying) {
    const { width: viewW, height: viewH } = app.value.renderer
    const sensitivity = live2dStore.eyeFocusSensitivity
    const nx = clamp((pointer.value.x - model.value.position.x) * sensitivity / viewW, -1, 1)
    const ny = clamp(-(pointer.value.y - model.value.position.y) * sensitivity / viewH, -1, 1)

    if (Date.now() - moveCursorTimestamp.value > live2dStore.eyeFocusTimeout) {
      eyeFocus.idleUpdate(internalModel, Date.now())
    }
    else {
      eyeFocus.mouseMoveUpdate(internalModel, [nx, ny])
    }
  }
  else {
    eyeFocus.resetFocus(internalModel)
  }

  // 口型同步：开启该功能且播放音频时，根据实时音量驱动嘴部张合
  if (live2dStore.useLipSync) {
    const coreModel = internalModel.coreModel as CubismModel
    const mouthOpenY = audioStore.isPlaying ? clamp(audioStore.volume * live2dStore.lipSyncGain, 0, 1) : 0
    coreModel.setParameterValueById('ParamMouthOpenY', mouthOpenY)
  }
}

/**
 * 监听窗口尺寸变化，重新设置渲染器尺寸并重新适配模型
 */
function onResize() {
  if (!app.value || !containerRef.value) return
  const { clientWidth, clientHeight } = containerRef.value
  app.value.renderer.resize(clientWidth, clientHeight)
  fitModelToCanvas()
}

/**
 * 卸载当前模型：解绑事件、从舞台移除并销毁
 */
function unloadModel() {
  if (!model.value) return

  model.value.off('hit', handleHit)
  model.value.internalModel.motionManager.off('motionStart')
  model.value.internalModel.motionManager.off('motionFinish')

  app.value?.stage.removeChild(model.value as unknown as PIXI.Container)
  model.value.destroy({ children: true, texture: true, baseTexture: true })
  model.value = null
}

/**
 * 加载指定模型：卸载旧模型（如有），加载新模型并完成初始化
 */
async function loadModel(url: string) {
  if (!app.value) return

  unloadModel()

  model.value = await Live2DModel.from(url, { autoInteract: false })

  model.value.anchor.set(0.5, 0.5)
  app.value.stage.addChild(model.value as unknown as PIXI.Container)

  fitModelToCanvas()
  syncModelMeta()

  const motionManager = model.value.internalModel.motionManager

  // 绑定交互事件
  model.value.interactive = true
  model.value.buttonMode = true
  model.value.on('hit', handleHit)

  motionManager.on('motionStart', (group, index) => {
    localCurrentMotion.value = { group, index }
  })

  motionManager.on('motionFinish', () => {
    live2dStore.currentMotion = localCurrentMotion.value = { group: motionManager.groups.idle, index: 0 }
  })

  live2dStore.playExpression(live2dStore.defaultExpression.name)
}

onMounted(async () => {
  const container = containerRef.value
  if (!container) return

  // 创建透明背景的 PIXI 应用，作为桌面宠物的渲染画布
  app.value = new PIXI.Application({
    width: container.clientWidth,
    height: container.clientHeight,
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: sceneStore.resolution,
  })
  container.appendChild(app.value.view as HTMLCanvasElement)

  // 加载 Live2D 模型
  await loadModel(live2dStore.currentModel?.url ?? defaultModels[0]!.url)

  // 绑定舞台级交互事件
  app.value.stage.interactive = true
  app.value.stage.hitArea = app.value.screen
  app.value.stage.on('pointerdown', onPointerDown)
  app.value.stage.on('pointermove', onPointerMove)
  app.value.stage.on('pointerup', onPointerUp)
  app.value.stage.on('pointerupoutside', onPointerUp)
  app.value.stage.on('pointertap', (event: PIXI.InteractionEvent) => {
    model.value?.tap(event.data.global.x, event.data.global.y)
  })

  app.value.view.addEventListener?.('wheel', onWheel as EventListener, { passive: false })
  window.addEventListener('resize', onResize)

  app.value.ticker.maxFPS = sceneStore.maxFPS
  app.value.ticker.add(onTick)
})

// live2dStore 中的缩放/位置发生变化时（例如用户在设置面板中调整），同步到模型
watch(() => live2dStore.scale, applyTransform)
watch(() => live2dStore.position, applyTransform, { deep: true })

// sceneStore 中的渲染分辨率发生变化时，更新渲染器分辨率并重新适配画布尺寸
watch(() => sceneStore.resolution, (resolution) => {
  if (!app.value || !containerRef.value) return
  app.value.renderer.resolution = resolution
  onResize()
})

// sceneStore 中的最大帧率发生变化时，同步到 ticker
watch(() => sceneStore.maxFPS, (maxFPS) => {
  if (!app.value) return
  app.value.ticker.maxFPS = maxFPS
})

// live2dStore 中的 currentModel 发生变化时，自动卸载旧模型并加载新模型
watch(
  () => live2dStore.currentModel?.url,
  (url) => {
    if (url) loadModel(url)
  },
)

// live2dStore 中指定了新的动作 / 表情时，驱动模型播放
watch(
  () => live2dStore.currentMotion,
  (motion) => playMotion(motion.group, motion.index, MotionPriority.FORCE),
)

watch(
  () => live2dStore.currentExpression,
  (expression) => playExpression(expression.name),
)

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  app.value?.view.removeEventListener?.('wheel', onWheel as EventListener)
  app.value?.ticker.remove(onTick)

  unloadModel()
  app.value?.destroy(true, { children: true, texture: true, baseTexture: true })
  app.value = null
})
</script>

<template>
  <div ref="containerRef" class="live2d-container"></div>
</template>

<style scoped>
.live2d-container {
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.live2d-container :deep(canvas) {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
