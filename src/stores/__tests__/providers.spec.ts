import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { filterModelsByCategory, getProviderVoices, useProvidersStore } from '@/stores/providers'

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
    expect(store.getASRProviders().map((provider) => provider.id)).toEqual(['openai_asr', 'siliconflow_asr'])
  })

  it('每一类各自记住正在使用的 provider，删除时一并清掉', () => {
    const store = useProvidersStore()
    const asr = store.getProviderById('siliconflow_asr')!
    expect(store.isCurrentProvider(asr)).toBe(false)
    store.setCurrentProvider(asr)
    expect(store.isCurrentProvider(asr)).toBe(true)
    expect(store.getCurrentASRProvider()?.id).toBe('siliconflow_asr')
    // 不影响其他种类
    expect(store.currentLLMProviderId).toBe('my-api')

    store.removeProvider('siliconflow_asr')
    expect(store.getCurrentASRProvider()).toBeNull()
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
})
