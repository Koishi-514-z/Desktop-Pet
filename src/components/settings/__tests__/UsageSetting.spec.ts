import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import UsageSetting from '@/components/settings/UsageSetting.vue'
import { useUsageStore } from '@/stores/usage'

describe('用量统计页面', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    // providers store 中注册了 onMounted，在组件外创建时 Vue 会给出提示，这里不关心
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('按 Provider 列出每个模型的用量；填写价格后算出费用，没有价格的提示未设置', async () => {
    const usage = useUsageStore()
    usage.record({ providerId: 'gone', providerName: '某中转', modelId: 'gpt-x', kind: 'llm' }, { inputTokens: 2_000_000, outputTokens: 500_000 })
    usage.record({ providerId: 'gone', providerName: '某中转', modelId: 'tts-1', kind: 'tts' }, { characters: 1200 })
    usage.setPrice('gone', 'gpt-x', { currency: 'USD', input: 1, output: 4 })

    const wrapper = mount(UsageSetting)
    // 2 × $1 + 0.5 × $4
    expect(wrapper.get('.overview-level').text()).toBe('$4.00')
    expect(wrapper.get('.overview-hint').text()).toContain('1 个模型还没有设置价格')
    expect(wrapper.get('.tile-title').text()).toContain('某中转')
    expect(wrapper.get('.tile-title').text()).toContain('已删除')

    const rows = wrapper.findAll('.usage-row')
    expect(rows[0]!.get('.row-usage').text()).toContain('输入 200 万 · 输出 50 万 token')
    expect(rows[1]!.get('.row-cost').text()).toBe('未设置价格')

    // 给语音合成填价格：每百万字符 ¥100
    await rows[1]!.get('.price-button').trigger('click')
    const input = wrapper.get('.price-editor input')
    await input.setValue('100')
    await input.trigger('change')
    expect(usage.getPrice('gone', 'tts-1')).toEqual({ currency: 'CNY', characters: 100 })
    expect(wrapper.findAll('.usage-row')[1]!.get('.row-cost').text()).toBe('¥0.12')
    expect(wrapper.get('.overview-level').text()).toBe('$4.00 + ¥0.12')
  })

  it('清空用量记录需要再点一次确认', async () => {
    const usage = useUsageStore()
    usage.record({ providerId: 'p', providerName: 'P', modelId: 'm', kind: 'asr' }, { seconds: 90 })
    const wrapper = mount(UsageSetting)
    expect(wrapper.get('.row-usage').text()).toContain('1 分 30 秒')
    const button = wrapper.get('.usage-footer .reset-button')
    await button.trigger('click')
    expect(usage.records).toHaveLength(1)
    await button.trigger('click')
    expect(usage.records).toHaveLength(0)
    expect(wrapper.text()).toContain('还没有用量记录')
  })
})
