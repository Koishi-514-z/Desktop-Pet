import { computed, onMounted, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useLocalStorage } from '@vueuse/core'
import { randInt } from '@/utils/math'

export interface Live2dMotion {
  group: string
  index: number
  fileName: string
  tags?: string[]
}

export interface Live2dHitArea {
  name: string
  id: string
  motion?: string
}

export interface Live2dExpression {
  name: string
  fileName: string
  tags?: string[]
}

export interface Live2dModel {
  id: string
  name: string
  description?: string
  url: string
  image: string
  position: { x: number, y: number }
  scale: number
  defaultExpression: { name: string }
  // 常驻表情：一直叠加在模型上、不会被其他表情替换的表情名称，
  // 对应 VTube Studio 里可以同时开启的开关类表情（如去水印、眼镜、外套）
  persistentExpressions?: string[]
  availableMotions: Live2dMotion[]
  availableHitAreas: Live2dHitArea[]
  availableExpressions: Live2dExpression[]
}

function createModelId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `model-${Math.random().toString(36).slice(2)}`
}

// 切换到非默认的表情后，多久自动切回默认表情（毫秒）
export const EXPRESSION_REVERT_MS = 30_000

const MODEL_ROOT = '/assets/live2d/models'

interface PresetModelOptions {
  id: string
  name: string
  /** public/assets/live2d/models 下的文件夹，其中有 model.model3.json 与同名的预览图 */
  folder: string
  description?: string
  position: { x: number, y: number }
  scale: number
  defaultExpression?: string
  persistentExpressions?: string[]
}

function presetModel(options: PresetModelOptions): Live2dModel {
  const { id, name, folder, description = '', position, scale, defaultExpression = '', persistentExpressions } = options
  return {
    id,
    name,
    description,
    url: `${MODEL_ROOT}/${folder}/model.model3.json`,
    image: `${MODEL_ROOT}/${folder}/${folder}.png`,
    position,
    scale,
    defaultExpression: { name: defaultExpression },
    ...(persistentExpressions ? { persistentExpressions } : {}),
    // 动作、碰撞区域、表情在模型加载后自动填充
    availableMotions: [],
    availableHitAreas: [],
    availableExpressions: [],
  }
}

// 预置模型列表：第一个是第一次启动时使用的模型。预置模型不能在设置中删除
export const defaultModels: Live2dModel[] = [
  presetModel({ id: 'atri', name: 'ATRI', folder: 'ATRI', description: '默认桌宠模型', position: { x: 1513, y: 676 }, scale: 0.22 }),
  presetModel({ id: 'ayachi-nene', name: 'AyachiNene', folder: 'AyachiNene', position: { x: 1493, y: 1048 }, scale: 0.3 }),
  presetModel({ id: 'clover-days', name: 'CloverDays', folder: 'CloverDays', position: { x: 800, y: 500 }, scale: 0.3 }),
  presetModel({ id: 'kuma-maid', name: 'KumaMaid', folder: 'Kuma_Maid', position: { x: 1510, y: 738 }, scale: 0.2, }),
  presetModel({ id: 'murasame', name: 'Murasame', folder: 'Murasame', position: { x: 781, y: 601 }, scale: 0.22 }),
  presetModel({ id: 'pudding', name: 'pudding', folder: 'pudding', position: { x: 1282, y: 607 }, scale: 0.2 }),
  presetModel({ id: 'virescent-fawn-witch', name: 'Virescent Fawn Witch', folder: 'Virescent Fawn Witch', position: { x: 1494, y: 713 }, scale: 0.23 }),
  presetModel({ id: 'ayane-pumk-version', name: 'Ayane PUMK version', folder: 'Ayane PUMK version', position: { x: 1524, y: 869 }, scale: 0.22, persistentExpressions: ['Watermark Hide.exp3'] }),
  presetModel({ id: 'ayane-sweater-over-sailor-uniform', name: 'Ayane sweater over sailor uniform', folder: 'Ayane sweater over sailor uniform', position: { x: 1504, y: 719 }, scale: 0.3, persistentExpressions: ['Watermark Hide.exp3'] }),
]

/**
 * 读取保存的模型列表时，把列表中还没有的预置模型（按 id 或模型文件判断）加到末尾，
 * 这样之后新增的预置模型也会出现；已有模型的设置保持不变
 */
export function mergeDefaultModels(stored: Live2dModel[], defaults: Live2dModel[]): Live2dModel[] {
  const missing = defaults.filter((preset) => !stored.some((model) => model.id === preset.id || model.url === preset.url))
  return missing.length ? [...stored, ...missing] : stored
}


export const useLive2dStore = defineStore('live2d', () => {
  // 用预置模型的副本：列表中的模型会被修改（拖拽、缩放等），不能改到预置的数据
  const models = useLocalStorage<Live2dModel[]>('settings/live2d/models', structuredClone(defaultModels), {
    mergeDefaults: mergeDefaultModels,
  })
  const currentModelId = useLocalStorage<string>('settings/live2d/currentModelId', defaultModels[0]!.id)

  const currentModel = computed(() => models.value.find((model) => model.id === currentModelId.value))
  const defaultExpression = computed(() => currentModel.value?.defaultExpression ?? { name: '' })

  const availableMotions = computed({
    get: () => currentModel.value?.availableMotions ?? [],
    set: (value) => { if (currentModel.value) currentModel.value.availableMotions = value },
  })

  const availableHitAreas = computed({
    get: () => currentModel.value?.availableHitAreas ?? [],
    set: (value) => { if (currentModel.value) currentModel.value.availableHitAreas = value },
  })

  const availableExpressions = computed({
    get: () => currentModel.value?.availableExpressions ?? [],
    set: (value) => { if (currentModel.value) currentModel.value.availableExpressions = value },
  })

  const motionMaps = computed(() => {
    const map = new Map<string, Live2dMotion[]>()
    for (const motion of currentModel.value?.availableMotions ?? []) {
      if (!map.has(motion.group)) map.set(motion.group, [])
      map.get(motion.group)!.push(motion)
    }
    return map
  })

  const currentMotion = ref<{ group: string, index: number }>({ group: 'Idle', index: 0 })
  const currentExpression = ref<{ name: string }>(defaultExpression.value)

  // ===== 全局可配置选项 =====

  // 视线跟随：鼠标静止超过 eyeFocusTimeout（毫秒）后，切换为自动随机扫视；
  // eyeFocusSensitivity 为跟随灵敏度，数值越大眼球转动幅度越大
  // focusLerpFactorIdle 为空闲时缓动系数，focusLerpFactorMouse 为鼠标跟随时缓动系数
  const useFocus = useLocalStorage('settings/live2d/useFocus', true)
  const eyeFocusTimeout = useLocalStorage('settings/live2d/eyeFocusTimeout', 10000)
  const eyeFocusSensitivity = useLocalStorage('settings/live2d/eyeFocusSensitivity', 5)
  const focusLerpFactorIdle = useLocalStorage('settings/live2d/focusLerpFactorIdle', 0.005)
  const focusLerpFactorMouse = useLocalStorage('settings/live2d/focusLerpFactorMouse', 0.02)

  // 口型同步：根据音频播放音量驱动嘴部张合
  // lipSyncGain 为音量放大倍数
  const useLipSync = useLocalStorage('settings/live2d/useLipSync', true)
  const lipSyncGain = useLocalStorage('settings/live2d/lipSyncGain', 3)

  // 鼠标交互：拖拽移动模型 / 滚轮缩放模型 / 点击触发动作组
  // scrollScaleStep 为每次滚轮缩放的步长，minScale/maxScale 为缩放范围限制
  const useDrag = useLocalStorage('settings/live2d/useDrag', true)
  const useScroll = useLocalStorage('settings/live2d/useScroll', true)
  const scrollScaleStep = useLocalStorage('settings/live2d/scrollScaleStep', 0.01)
  const minScale = useLocalStorage('settings/live2d/minScale', 0.1)
  const maxScale = useLocalStorage('settings/live2d/maxScale', 10)
  const useHit = useLocalStorage('settings/live2d/useHit', true)

  // 切换回 defaultExpression 的定时器
  let expressionTimer: ReturnType<typeof setTimeout> | undefined

  // 当前模型在画布中的位置 / 缩放，读写均代理到 currentModel
  const position = computed({
    get: () => currentModel.value?.position ?? { x: 0, y: 0 },
    set: (value) => {
      if (currentModel.value) currentModel.value.position = value
    },
  })

  const scale = computed({
    get: () => currentModel.value?.scale ?? 1,
    set: (value) => {
      if (currentModel.value) currentModel.value.scale = value
    },
  })

  function getModelById(id: string) {
    return models.value.find((model) => model.id === id)
  }

  // 新增模型，未指定 id 时自动生成
  function addModel(model: Omit<Live2dModel, 'availableMotions' | 'availableHitAreas' | 'availableExpressions'>) {
    if (!model.id) model.id = createModelId()
    models.value.push({ ...model, availableMotions: [], availableHitAreas: [], availableExpressions: [] })
    return model.id
  }

  // 删除模型，若删除的是当前模型则自动切换到列表中的第一个
  function removeModel(id: string) {
    const index = models.value.findIndex((model) => model.id === id)
    if (index === -1) return

    models.value.splice(index, 1)

    if (currentModelId.value === id) {
      currentModelId.value = models.value[0]?.id ?? ''
    }
  }

  // 更新模型的部分字段
  function updateModel(id: string, patch: Partial<Omit<Live2dModel, 'id'>>) {
    const model = getModelById(id)
    if (!model) return
    Object.assign(model, patch)
  }

  // 切换当前选中的模型
  function switchModel(id: string) {
    if (!models.value.some((model) => model.id === id)) return
    currentModelId.value = id
  }

  function isDefaultModel(id: string) {
    return defaultModels.some((model) => model.id === id)
  }

  // 播放指定动作。若未指定 index，则随机选择一个动作
  function playMotion(group: string, index?: number) {
    if (index === undefined) {
      const motions = motionMaps.value.get(group)
      if (!motions || motions.length === 0) return
      index = randInt(0, motions.length - 1)
    }
    currentMotion.value = { group, index }
  }

  // 随机做一个动作（不含待机动作）。模型没有别的动作时什么也不做
  function playRandomMotion() {
    const motions = availableMotions.value.filter((motion) => !/^idle$/i.test(motion.group))
    if (motions.length === 0) return
    const motion = motions[randInt(0, motions.length - 1)]!
    playMotion(motion.group, motion.index)
  }

  function playMotionByTag(tag: string) {
    const motions = availableMotions.value.filter(motion => motion.tags?.includes(tag))
    if (motions.length === 0) return

    const randomIndex = randInt(0, motions.length - 1)
    const motion = motions[randomIndex]!
    playMotion(motion.group, motion.index)
  }

  // 播放指定表情。非默认的表情在 duration（毫秒，默认约半分钟）后自动切回 defaultExpression，
  // 期间切换到别的表情时重新计时。每次都换成新的对象，确保界面上的模型一定会收到变化
  function playExpression(name: string, duration = EXPRESSION_REVERT_MS) {
    if (expressionTimer) {
      clearTimeout(expressionTimer)
      expressionTimer = undefined
    }

    currentExpression.value = { name }

    if (name !== defaultExpression.value.name && duration > 0) {
      expressionTimer = setTimeout(() => {
        expressionTimer = undefined
        currentExpression.value = { name: defaultExpression.value.name }
      }, duration)
    }
  }

  // 随机换一个表情：尽量不选默认表情、当前的表情和常驻表情，否则看起来没有变化
  function playRandomExpression(duration?: number) {
    const persistent = currentModel.value?.persistentExpressions ?? []
    const others = availableExpressions.value.filter(
      (expression) => expression.name !== defaultExpression.value.name
        && expression.name !== currentExpression.value.name
        && !persistent.includes(expression.name),
    )
    const candidates = others.length > 0 ? others : availableExpressions.value
    if (candidates.length === 0) return
    playExpression(candidates[randInt(0, candidates.length - 1)]!.name, duration)
  }

  function playExpressionByTag(tag: string, duration?: number) {
    const expressions = availableExpressions.value.filter(expression => expression.tags?.includes(tag))
    if (expressions.length === 0) return

    const randomIndex = randInt(0, expressions.length - 1)
    playExpression(expressions[randomIndex]!.name, duration)
  }

  function playDefaultExpression(duration?: number) {
    playExpression(defaultExpression.value.name, duration)
  }

  function resetGlobalOptionsToDefault() {
    useFocus.value = true
    eyeFocusTimeout.value = 10000
    eyeFocusSensitivity.value = 5
    focusLerpFactorIdle.value = 0.005
    focusLerpFactorMouse.value = 0.02
    useLipSync.value = true
    lipSyncGain.value = 3
    useDrag.value = true
    useScroll.value = true
    scrollScaleStep.value = 0.01
    minScale.value = 0.1
    maxScale.value = 10
    useHit.value = true
  }

  function resetAllToDefault() {
    models.value = structuredClone(defaultModels)
    currentModelId.value = defaultModels[0]!.id
    resetGlobalOptionsToDefault()
  }

  watch(
    () => defaultExpression.value.name,
    () => playDefaultExpression(),
    { immediate: true }
  )

  onMounted(() => {
    // resetAllToDefault()
  })

  return {
    models,
    currentModelId,
    currentModel,
    defaultExpression,
    position,
    scale,
    availableMotions,
    availableHitAreas,
    availableExpressions,
    motionMaps,
    currentMotion,
    currentExpression,

    useFocus,
    eyeFocusTimeout,
    eyeFocusSensitivity,
    focusLerpFactorIdle,
    focusLerpFactorMouse,
    useLipSync,
    lipSyncGain,
    useDrag,
    useScroll,
    scrollScaleStep,
    minScale,
    maxScale,
    useHit,

    getModelById,
    addModel,
    removeModel,
    updateModel,
    switchModel,

    playMotion,
    playRandomMotion,
    playMotionByTag,
    playExpression,
    playExpressionByTag,
    playRandomExpression,
    playDefaultExpression,
    isDefaultModel,
    resetGlobalOptionsToDefault,
    resetAllToDefault,
  }
})
