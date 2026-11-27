import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { filterModelsByCategory, getProviderVoices, getRating, sortByRating, useProvidersStore } from '@/stores/providers'

describe('provider 的模型筛选', () => {
  const ids = ['gpt-4o', 'whisper-1', 'gpt-4o-mini-transcribe', 'tts-1', 'FunAudioLLM/SenseVoiceSmall', 'TeleAI/TeleSpeechASR']

  it('按种类筛选 OpenAI 兼容接口返回的模型', () => {
    expect(filterModelsByCategory(ids, 'tts')).toEqual(['tts-1'])
    expect(filterModelsByCategory(ids, 'asr')).toEqual(['whisper-1', 'gpt-4o-mini-transcribe', 'FunAudioLLM/SenseVoiceSmall', 'TeleAI/TeleSpeechASR'])
    expect(filterModelsByCategory(ids, 'llm')).not.toContain('tts-1')
  })

  it('语音识别一个都没筛到时（如本地服务的模型名）返回全部', () => {
    expect(filterModelsByCategory(['my-local-model'], 'asr')).toEqual(['my-local-model'])
  })
})

describe('provider 列表', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    // store 中注册了 onMounted，在组件外创建时 Vue 会给出提示，这里不关心
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('保存的列表中缺少的预置 provider（如新增的语音识别）会补上，已有的设置不变', () => {
    localStorage.setItem('settings/providers', JSON.stringify([
      { id: 'openai', name: '我的 OpenAI', category: 'llm', protocol: 'openai', baseUrl: 'https://example.com/v1', apiKey: 'sk-test', models: [], selectedModelId: '', isValid: false },
    ]))
    const store = useProvidersStore()
    expect(store.getProviderById('openai')).toMatchObject({ name: '我的 OpenAI', apiKey: 'sk-test' })
    expect(store.getASRProviders().map((provider) => provider.id)).toEqual(['openai_asr', 'siliconflow_asr', '99a0a0af-0ca8-4026-80db-97b8b7b88a2c'])
  })

  it('恢复默认后回到预置的数据（方法保留），之后的修改不会改到预置的 provider', () => {
    const store = useProvidersStore()
    const id = store.providers[0]!.id
    store.getProviderById(id)!.apiKey = 'sk-changed'
    store.resetAllToDefault()
    expect(store.getProviderById(id)!.apiKey).toBe('')
    expect(typeof store.getProviderById(id)!.validator).toBe('function')

    store.getProviderById(id)!.apiKey = 'sk-changed'
    store.resetAllToDefault()
    expect(store.getProviderById(id)!.apiKey).toBe('')
  })

  it('每一类各自记住正在使用的 provider，删除时一并清掉', () => {
    const store = useProvidersStore()
    const asr = store.getProviderById('siliconflow_asr')!
    expect(store.isCurrentProvider(asr)).toBe(false)
    store.setCurrentProvider(asr)
    expect(store.isCurrentProvider(asr)).toBe(true)
    expect(store.getCurrentASRProvider()?.id).toBe('siliconflow_asr')
    // 不影响其他种类
    expect(store.currentLLMProviderId).toBe('ff32b31e-31d3-4148-aedc-3e1780e49abd')

    store.removeProvider('siliconflow_asr')
    expect(store.getCurrentASRProvider()).toBeNull()
  })

  it('配置相同的两个 provider（如同一个 Key 的千问 TTS 与 ASR）各用各的缓存', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const store = useProvidersStore()
    const base = { protocol: 'dashscope' as const, baseUrl: 'https://dashscope.aliyuncs.com', apiKey: '', models: [], selectedModelId: '', isValid: false }
    // 先不填 Key（不会发出请求），替换掉获取列表的方法后再填上，这时才加载信息、写入缓存
    async function add(category: 'tts' | 'asr', model: string) {
      const id = await store.addProvider({ id: '', name: `千问 ${category}`, category, ...base, ...(category === 'tts' ? { voices: [], selectedVoiceId: '' } : {}) })
      Object.assign(store.getProviderById(id)!, {
        validator: async () => true,
        listModels: async () => [{ id: model, name: model }],
        listVoices: async () => [{ id: 'Cherry', name: 'Cherry' }],
      })
      await store.updateProvider(id, { apiKey: 'sk-same' })
      return store.getProviderById(id)!
    }

    const asr = await add('asr', 'qwen3-asr-flash')
    const tts = await add('tts', 'qwen3-tts-flash')
    expect(asr.selectedModelId).toBe('qwen3-asr-flash')
    expect(tts.selectedModelId).toBe('qwen3-tts-flash')
    expect(tts.selectedVoiceId).toBe('Cherry')
  })

  it('可以手动输入音色 ID：刷新声线列表后仍然选中，移除后改选列表中的声线', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const store = useProvidersStore()
    const id = await store.addProvider({
      id: '', name: '我的 TTS', category: 'tts', protocol: 'openai', baseUrl: 'https://example.com/v1', apiKey: '',
      models: [], selectedModelId: '', isValid: false, voices: [], selectedVoiceId: '',
    })
    const provider = store.getProviderById(id)!
    // 不发出请求：替换掉验证与获取列表的方法
    Object.assign(provider, {
      apiKey: 'sk-test',
      validator: async () => true,
      listModels: async () => [],
      listVoices: async () => [{ id: 'alloy', name: 'Alloy' }],
    })
    await store.refreshProviderInfo(id)
    expect(provider.selectedVoiceId).toBe('alloy')

    store.addCustomVoice(id, { id: ' my-voice ', name: '我的音色' })
    expect(provider.selectedVoiceId).toBe('my-voice')
    expect(getProviderVoices(provider)).toEqual([
      { id: 'my-voice', name: '我的音色', description: '手动输入 · my-voice' },
      { id: 'alloy', name: 'Alloy' },
    ])
    await store.refreshProviderInfo(id)
    expect(provider.selectedVoiceId).toBe('my-voice')

    // 列表中已有的音色直接选中，不重复添加
    store.addCustomVoice(id, { id: 'alloy' })
    expect(provider.selectedVoiceId).toBe('alloy')
    expect(provider.customVoices).toHaveLength(1)

    store.addCustomVoice(id, { id: 'my-voice' })
    store.removeCustomVoice(id, 'my-voice')
    expect(provider.customVoices).toEqual([])
    expect(provider.selectedVoiceId).toBe('alloy')
  })

  it('可以给模型和声线打分：刷新列表后评分还在，可以按评分排列，移除手动输入的音色时评分一并清掉', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const store = useProvidersStore()
    const id = await store.addProvider({
      id: '', name: '我的 TTS', category: 'tts', protocol: 'openai', baseUrl: 'https://example.com/v1', apiKey: '',
      models: [], selectedModelId: '', isValid: false, voices: [], selectedVoiceId: '',
    })
    const provider = store.getProviderById(id)!
    Object.assign(provider, {
      apiKey: 'sk-test',
      validator: async () => true,
      listModels: async () => [{ id: 'tts-1', name: 'tts-1' }, { id: 'tts-1-hd', name: 'tts-1-hd' }],
      listVoices: async () => [{ id: 'alloy', name: 'Alloy' }, { id: 'echo', name: 'Echo' }, { id: 'nova', name: 'Nova' }],
    })
    await store.refreshProviderInfo(id)

    store.setRating(id, 'models', 'tts-1-hd', 4)
    store.setRating(id, 'voices', 'nova', 5)
    store.setRating(id, 'voices', 'echo', 9) // 超出范围的按 5 星算
    store.setRating(id, 'voices', 'alloy', 2)
    store.setRating(id, 'voices', 'alloy', 0) // 0 表示清除
    // 只是打分，不会改变选中的模型 / 声线
    expect(provider.selectedModelId).toBe('tts-1')
    expect(provider.selectedVoiceId).toBe('alloy')

    await store.refreshProviderInfo(id)
    expect(provider.ratings).toEqual({ models: { 'tts-1-hd': 4 }, voices: { nova: 5, echo: 5 } })
    expect(getRating(provider, 'models', 'tts-1')).toBe(0)
    expect(sortByRating(provider.models, provider, 'models').map((m) => m.id)).toEqual(['tts-1-hd', 'tts-1'])
    // 评分相同的保持原来的顺序，没打过分的排在最后
    expect(sortByRating(provider.voices!, provider, 'voices').map((v) => v.id)).toEqual(['echo', 'nova', 'alloy'])

    store.addCustomVoice(id, { id: 'my-voice' })
    store.setRating(id, 'voices', 'my-voice', 3)
    store.removeCustomVoice(id, 'my-voice')
    expect(getRating(provider, 'voices', 'my-voice')).toBe(0)
    expect(provider.ratings?.voices).toEqual({ nova: 5, echo: 5 })
  })
})
