import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXPRESSION_REVERT_MS, useLive2dStore } from '@/stores/live2d'

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
