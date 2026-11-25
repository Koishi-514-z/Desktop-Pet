import type { Provider } from '@/stores/providers'
import { experimental_generateSpeech as generateSpeech, experimental_transcribe as transcribe } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const httpFetch = vi.hoisted(() => vi.fn<(input: string, init?: RequestInit) => Promise<Response>>())
vi.mock('@/utils/http', () => ({ httpFetch }))

import {
  createDashScopeSpeechModel,
  createDashScopeTranscriptionModel,
  dashscopeCompatibleUrl,
  dashscopeModels,
  dashscopeRoot,
} from '@/utils/dashscope'

function provider(patch: Partial<Provider> = {}): Provider {
  return {
    id: 'qwen', name: 'Qwen', category: 'tts', protocol: 'dashscope', baseUrl: 'https://maas.qianwenaiapi.com/compatible-mode/v1',
    apiKey: 'sk-test', models: [], selectedModelId: 'qwen3-tts-flash', selectedVoiceId: 'Cherry', isValid: true,
    validator: async () => true, listModels: async () => [], ...patch,
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
// 一个最小的 WAV 文件
const WAV = Uint8Array.from([...'RIFF'].map((c) => c.charCodeAt(0)).concat([36, 0, 0, 0], [...'WAVEfmt '].map((c) => c.charCodeAt(0)), Array(28).fill(0)))
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

beforeEach(() => {
  httpFetch.mockReset()
})

describe('百炼的地址与模型', () => {
  it('Base URL 可以带 /compatible-mode/v1 或 /api/v1，也可以只写根地址', () => {
    expect(dashscopeRoot('https://maas.qianwenaiapi.com/compatible-mode/v1/')).toBe('https://maas.qianwenaiapi.com')
    expect(dashscopeRoot('https://dashscope.aliyuncs.com/api/v1')).toBe('https://dashscope.aliyuncs.com')
    expect(dashscopeRoot('https://dashscope.aliyuncs.com')).toBe('https://dashscope.aliyuncs.com')
    expect(dashscopeCompatibleUrl('https://dashscope.aliyuncs.com')).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
  })

  it('只列出能用的模型：去掉实时（WebSocket）与异步转写的模型，没有时补上官方文档中的模型', () => {
    const ids = ['qwen-plus', 'qwen3-tts-flash', 'qwen3-tts-flash-realtime', 'qwen-audio-3.0-asr-flash', 'qwen3-asr-flash-realtime', 'qwen3-asr-flash-filetrans']
    expect(dashscopeModels(ids, 'tts').map((model) => model.id)).toEqual(['qwen3-tts-flash'])
    expect(dashscopeModels(ids, 'asr').map((model) => model.id)).toEqual(['qwen3-asr-flash', 'qwen-audio-3.0-asr-flash'])
    expect(dashscopeModels([], 'tts').map((model) => model.id)).toEqual(['qwen3-tts-flash'])
  })
})

describe('千问语音合成', () => {
  it('调用原生接口，音频以下载地址返回时再下载', async () => {
    httpFetch
      .mockResolvedValueOnce(json({ code: '', output: { audio: { data: '', url: 'https://oss.example.com/a.wav' } } }))
      .mockResolvedValueOnce(new Response(WAV))
    const { audio } = await generateSpeech({ model: createDashScopeSpeechModel(provider()), text: '你好呀', voice: 'Ethan' })

    const [url, init] = httpFetch.mock.calls[0]!
    expect(url).toBe('https://maas.qianwenaiapi.com/api/v1/services/aigc/multimodal-generation/generation')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
    expect(JSON.parse(init?.body as string)).toEqual({ model: 'qwen3-tts-flash', input: { text: '你好呀', voice: 'Ethan' } })
    expect(httpFetch.mock.calls[1]![0]).toBe('https://oss.example.com/a.wav')
    expect(audio.uint8Array).toEqual(WAV)
    expect(audio.mediaType).toBe('audio/wav')
  })

  it('音频直接以 base64 返回时不再下载；没有选声线时用默认的 Cherry；超过 600 字的部分截掉', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    httpFetch.mockResolvedValueOnce(json({ code: '', output: { audio: { data: base64(WAV) } } }))
    const { audio } = await generateSpeech({ model: createDashScopeSpeechModel(provider({ selectedVoiceId: '' })), text: '啊'.repeat(700) })
    expect(httpFetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(httpFetch.mock.calls[0]![1]?.body as string)
    expect(body.input.voice).toBe('Cherry')
    expect(body.input.text).toHaveLength(600)
    expect(audio.uint8Array).toEqual(WAV)
    vi.restoreAllMocks()
  })

  it('出错时说明原因', async () => {
    httpFetch.mockResolvedValueOnce(json({ code: 'InvalidApiKey', message: 'No API-key provided.' }, 401))
    await expect(generateSpeech({ model: createDashScopeSpeechModel(provider()), text: '你好', maxRetries: 0 }))
      .rejects.toThrow('千问接口出错（HTTP 401）：No API-key provided.')
  })
})

describe('千问语音识别', () => {
  it('录音以 data URL 发送，取出识别出的文字与语言', async () => {
    httpFetch.mockResolvedValueOnce(json({
      code: '',
      output: { choices: [{ message: { role: 'assistant', content: [{ text: '欢迎使用阿里云。' }], annotations: [{ language: 'zh', type: 'audio_info' }] } }] },
    }))
    const result = await transcribe({
      model: createDashScopeTranscriptionModel(provider({ category: 'asr', selectedModelId: 'qwen3-asr-flash' })),
      audio: WAV,
    })

    const [url, init] = httpFetch.mock.calls[0]!
    expect(url).toBe('https://maas.qianwenaiapi.com/api/v1/services/aigc/multimodal-generation/generation')
    expect(JSON.parse(init?.body as string)).toEqual({
      model: 'qwen3-asr-flash',
      input: { messages: [{ role: 'user', content: [{ audio: `data:audio/wav;base64,${base64(WAV)}` }] }] },
    })
    expect(result.text).toBe('欢迎使用阿里云。')
    expect(result.language).toBe('zh')
  })
})
