import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultModels, EXPRESSION_REVERT_MS, mergeDefaultModels, useLive2dStore } from '@/stores/live2d'

// 测试在项目根目录下运行（jsdom 环境中 import.meta.url 不是 file:// 地址）
const PUBLIC_DIR = resolve(process.cwd(), 'public')

describe('表情', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    setActivePinia(createPinia())
    // store 中注册了 onMounted，在组件外创建时 Vue 会给出提示，这里不关心
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function setup() {
    const store = useLive2dStore()
    store.availableExpressions = ['expression1.exp3', 'smile', 'angry'].map((name) => ({ name, fileName: `${name}.json` }))
    return store
  }

  it('切换到非默认的表情后，约半分钟自动切回默认表情', () => {
    const store = setup()
    store.playExpression('smile')
    expect(store.currentExpression.name).toBe('smile')

    vi.advanceTimersByTime(EXPRESSION_REVERT_MS - 1)
    expect(store.currentExpression.name).toBe('smile')
    vi.advanceTimersByTime(1)
    expect(store.currentExpression.name).toBe(store.defaultExpression.name)
  })

  it('期间换成别的表情时重新计时；切回默认表情后不再计时', () => {
    const store = setup()
    store.playExpression('smile')
    vi.advanceTimersByTime(EXPRESSION_REVERT_MS - 1000)
    store.playExpression('angry')
    vi.advanceTimersByTime(EXPRESSION_REVERT_MS - 1000)
    expect(store.currentExpression.name).toBe('angry')

    store.playDefaultExpression()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('随机换表情时不选默认表情和当前的表情', () => {
    const store = setup()
    store.playExpression('smile')
    for (let i = 0; i < 10; i++) {
      store.playExpression('smile')
      store.playRandomExpression()
      expect(store.currentExpression.name).toBe('angry')
    }
  })

  it('没有设置默认表情时，到时也会切回（由模型组件恢复原本的样子）', () => {
    const store = setup()
    store.currentModel!.defaultExpression = { name: '' }
    store.playExpression('smile')
    vi.advanceTimersByTime(EXPRESSION_REVERT_MS)
    expect(store.currentExpression).toEqual({ name: '' })
  })
})

describe('预置模型', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('每个预置模型的模型文件与预览图都存在，id 不重复，第一个是 ATRI', () => {
    expect(defaultModels[0]!.id).toBe('atri')
    expect(new Set(defaultModels.map((model) => model.id)).size).toBe(defaultModels.length)
    for (const model of defaultModels) {
      expect(existsSync(PUBLIC_DIR + model.url), model.url).toBe(true)
      expect(existsSync(PUBLIC_DIR + model.image), model.image).toBe(true)
    }
  })

  it('保存的列表中缺少的预置模型加到末尾（同一个模型文件不重复加），已有模型的设置不变', () => {
    const [atri, nene] = defaultModels
    const stored = [
      { ...structuredClone(atri!), position: { x: 1, y: 2 } },
      // 用户自己添加的同一个模型（id 不同）
      { ...structuredClone(nene!), id: 'my-nene', name: '绫地宁宁' },
    ]
    const merged = mergeDefaultModels(stored, defaultModels)
    expect(merged.slice(0, 2)).toEqual(stored)
    expect(merged.map((model) => model.id)).toEqual(['atri', 'my-nene', ...defaultModels.slice(2).map((model) => model.id)])
    expect(mergeDefaultModels(merged, defaultModels)).toBe(merged)
  })

  it('启动时补上缺少的预置模型；恢复默认后回到预置的数据，之后的修改不会改到预置模型', () => {
    localStorage.setItem('settings/live2d/models', JSON.stringify([{ ...defaultModels[0], position: { x: 1, y: 2 } }]))
    const store = useLive2dStore()
    expect(store.models).toHaveLength(defaultModels.length)
    expect(store.models[0]!.position).toEqual({ x: 1, y: 2 })

    store.resetAllToDefault()
    expect(store.models).toEqual(defaultModels)
    store.position = { x: 3, y: 4 }
    expect(store.currentModel!.position).toEqual({ x: 3, y: 4 })
    expect(defaultModels[0]!.position).toEqual({ x: 1513, y: 676 })
  })
})

describe('情绪标签', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    setActivePinia(createPinia())
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function setup() {
    const store = useLive2dStore()
    store.availableExpressions = [
      { name: 'smile', fileName: 'smile.json', tags: ['happy'] },
      { name: 'cry', fileName: 'cry.json' },
      { name: 'Watermark Hide', fileName: 'watermark.json', tags: ['happy'] },
    ]
    store.availableMotions = [{ group: 'TapBody', index: 0, fileName: 'a.json' }]
    store.currentModel!.persistentExpressions = ['Watermark Hide']
    return store
  }

  it('按设置中打的标签播放表情，优先于模型文件中的；常驻表情不参与；没有时返回 false', () => {
    const store = setup()
    const id = store.currentModelId
    expect(store.playExpressionByTag('happy')).toBe(true)
    expect(store.currentExpression.name).toBe('smile')
    expect(store.playExpressionByTag('sad')).toBe(false)

    store.setExpressionTags(id, 'cry', ['sad', 'sobs'])
    expect(store.playExpressionByTag('sobs')).toBe(true)
    expect(store.currentExpression.name).toBe('cry')

    // 清空也算设置过：模型文件中的 happy 不再生效
    store.setExpressionTags(id, 'smile', [])
    expect(store.playExpressionByTag('happy')).toBe(false)
    // 恢复为模型文件中的
    store.setExpressionTags(id, 'smile', null)
    expect(store.playExpressionByTag('happy')).toBe(true)
  })

  it('按标签做动作；一类全部恢复为模型文件中的标签', () => {
    const store = setup()
    const id = store.currentModelId
    expect(store.playMotionByTag('laughs')).toBe(false)
    store.setMotionTags(id, { group: 'TapBody', index: 0 }, ['laughs', 'laughs'])
    expect(store.currentModel!.customTags!.motions).toEqual({ 'TapBody:0': ['laughs'] })
    expect(store.playMotionByTag('laughs')).toBe(true)
    expect(store.currentMotion).toEqual({ group: 'TapBody', index: 0 })

    store.setExpressionTags(id, 'cry', ['sad'])
    store.clearCustomTags(id, 'motions')
    expect(store.currentModel!.customTags).toEqual({ expressions: { cry: ['sad'] } })
    expect(store.playMotionByTag('laughs')).toBe(false)
  })
})

