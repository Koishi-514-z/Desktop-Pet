import type { Provider } from '@/stores/providers'
import { APICallError, experimental_generateSpeech as generateSpeech, experimental_transcribe as transcribe } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const httpFetch = vi.hoisted(() => vi.fn<(input: string, init?: RequestInit) => Promise<Response>>())
vi.mock('@/utils/http', () => ({ httpFetch }))

import {
  createFishAudioSpeechModel,
  createFishAudioTranscriptionModel,
  FISH_AUDIO_MAX_CONCURRENCY,
  listFishAudioVoices,
  validateFishAudio,
} from '@/utils/fish-audio'

function provider(patch: Partial<Provider> = {}): Provider {
  return {
    id: 'fish', name: 'Fish Audio', category: 'tts', protocol: 'fish-audio', baseUrl: '',
    apiKey: 'sk-test', models: [], selectedModelId: 's2-pro', selectedVoiceId: 'voice-1', isValid: true,
    validator: async () => true, listModels: async () => [], ...patch,
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
// 以 MP3 帧头开头的几个字节
const MP3 = Uint8Array.from([0xFF, 0xFB, 0x90, 0x64, 0x00, 0x0F, 0xF0, 0xAB])
const mp3 = () => new Response(MP3, { headers: { 'Content-Type': 'audio/mpeg' } })
// 一个最小的 WAV 文件
const WAV = Uint8Array.from([...'RIFF'].map((c) => c.charCodeAt(0)).concat([36, 0, 0, 0], [...'WAVEfmt '].map((c) => c.charCodeAt(0)), Array(28).fill(0)))
const headersOf = (init?: RequestInit) => init?.headers as Record<string, string>

beforeEach(() => {
  httpFetch.mockReset()
})

describe('Fish Audio 语音合成', () => {
  it('模型放在请求头里，声线作为 reference_id，直接返回音频', async () => {
    httpFetch.mockResolvedValueOnce(mp3())
    const { audio } = await generateSpeech({ model: createFishAudioSpeechModel(provider()), text: '你好呀', voice: 'voice-1' })

    const [url, init] = httpFetch.mock.calls[0]!
    expect(url).toBe('https://api.fish.audio/v1/tts')
    expect(init?.method).toBe('POST')
    expect(headersOf(init)).toEqual({ 'Authorization': 'Bearer sk-test', 'Content-Type': 'application/json', 'model': 's2-pro' })
    expect(JSON.parse(init?.body as string)).toEqual({ text: '你好呀', reference_id: 'voice-1', format: 'mp3' })
    expect(audio.uint8Array).toEqual(MP3)
    expect(audio.mediaType).toBe('audio/mpeg')
  })

  it('没有选模型、声线时用默认模型、不传声线；语速与输出格式按调用参数设置', async () => {
    httpFetch.mockResolvedValueOnce(mp3())
    await generateSpeech({ model: createFishAudioSpeechModel(provider({ selectedModelId: '' })), text: '你好', speed: 3, outputFormat: 'wav' })

    const [, init] = httpFetch.mock.calls[0]!
    expect(headersOf(init).model).toBe('s2.1-pro')
    expect(JSON.parse(init?.body as string)).toEqual({ text: '你好', format: 'wav', prosody: { speed: 2 } })
  })

  it('出错时说明原因；并发数超限（429）的错误交给 AI SDK 重试', async () => {
    httpFetch.mockResolvedValueOnce(json({ status: 402, message: 'Insufficient balance' }, 402))
    const noCredit = await generateSpeech({ model: createFishAudioSpeechModel(provider()), text: '你好', maxRetries: 0 }).catch((error) => error)
    expect(noCredit.message).toBe('Fish Audio 接口出错（HTTP 402）：API 余额不足（Insufficient balance）')
    expect(APICallError.isInstance(noCredit) && noCredit.isRetryable).toBe(false)

    httpFetch.mockResolvedValueOnce(json({ status: 429, message: 'Too many requests' }, 429))
    const tooMany = await generateSpeech({ model: createFishAudioSpeechModel(provider()), text: '你好', maxRetries: 0 }).catch((error) => error)
    expect(APICallError.isInstance(tooMany) && tooMany.isRetryable).toBe(true)

    httpFetch.mockResolvedValueOnce(new Response('', { status: 200, headers: { 'Content-Type': 'audio/mpeg' } }))
    await expect(generateSpeech({ model: createFishAudioSpeechModel(provider()), text: '你好', maxRetries: 0 }))
      .rejects.toThrow('Fish Audio 接口没有返回音频')
  })

  it(`同时最多发出 ${FISH_AUDIO_MAX_CONCURRENCY} 个请求，其余的按顺序排队`, async () => {
    const pending: ((response: Response) => void)[] = []
    httpFetch.mockImplementation(() => new Promise((resolve) => pending.push(resolve)))
    const model = createFishAudioSpeechModel(provider())
    const results = Array.from({ length: 6 }, (_, i) => generateSpeech({ model, text: `第 ${i} 句`, maxRetries: 0 }))

    await vi.waitFor(() => expect(httpFetch).toHaveBeenCalledTimes(FISH_AUDIO_MAX_CONCURRENCY))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(httpFetch).toHaveBeenCalledTimes(FISH_AUDIO_MAX_CONCURRENCY)

    pending[0]!(mp3())
    await vi.waitFor(() => expect(httpFetch).toHaveBeenCalledTimes(FISH_AUDIO_MAX_CONCURRENCY + 1))
    expect(JSON.parse(httpFetch.mock.calls[FISH_AUDIO_MAX_CONCURRENCY]![1]?.body as string).text).toBe(`第 ${FISH_AUDIO_MAX_CONCURRENCY} 句`)

    for (let i = 1; i < 6; i++) {
      await vi.waitFor(() => expect(pending.length).toBeGreaterThan(i))
      pending[i]!(mp3())
    }
    const audios = await Promise.all(results)
    expect(audios.map(({ audio }) => audio.uint8Array)).toEqual(Array(6).fill(MP3))
  })
})

describe('Fish Audio 语音识别', () => {
  it('录音以 multipart 表单上传，取出识别出的文字与语言', async () => {
    httpFetch.mockResolvedValueOnce(json({ text: ' 今天天气怎么样？ ', duration: 1.5, segments: [], language_code: 'zh' }))
    const result = await transcribe({
      model: createFishAudioTranscriptionModel(provider({ category: 'asr', selectedModelId: '' })),
      audio: WAV,
    })

    const [url, init] = httpFetch.mock.calls[0]!
    expect(url).toBe('https://api.fish.audio/v1/asr')
    expect(headersOf(init)).toEqual({ Authorization: 'Bearer sk-test', model: 'transcribe-1' })
    const form = init?.body as FormData
    expect((form.get('audio') as Blob).size).toBe(WAV.length)
    expect(form.get('ignore_timestamps')).toBe('true')
    expect(form.has('tag_audio_events')).toBe(false)
    expect(result.text).toBe('今天天气怎么样？')
    expect(result.language).toBe('zh')
    expect(result.durationInSeconds).toBe(1.5)
  })

  it('Pro 模型关闭声音事件标注与说话人区分', async () => {
    httpFetch.mockResolvedValueOnce(json({ text: '你好', duration: 0.8, segments: [] }))
    await transcribe({ model: createFishAudioTranscriptionModel(provider({ category: 'asr', selectedModelId: 'transcribe-1-pro' })), audio: WAV })

    const [, init] = httpFetch.mock.calls[0]!
    expect(headersOf(init).model).toBe('transcribe-1-pro')
    const form = init?.body as FormData
    expect(form.get('tag_audio_events')).toBe('false')
    expect(form.get('diarize')).toBe('false')
  })
})

describe('Fish Audio 声线与验证', () => {
  it('自己的声线排在前面，之后是声线库中常用的中文声线；去掉变声模型与没训练好的声线', async () => {
    httpFetch.mockImplementation(async (url) => url.includes('self=true')
      ? json({ total: 3, items: [
          { _id: 'mine', type: 'tts', state: 'trained', title: '我的声音', description: '', tags: [] },
          { _id: 'training', type: 'tts', state: 'training', title: '训练中' },
          { _id: 'svc', type: 'svc', state: 'trained', title: '变声' },
        ] })
      : json({ total: 2, items: [
          { _id: 'popular', type: 'tts', state: 'trained', title: '温柔女声', description: 'https://space.bilibili.com/1', tags: ['female', '温柔'] },
          { _id: 'mine', type: 'tts', state: 'trained', title: '我的声音' },
        ] }))
    const voices = await listFishAudioVoices(provider())

    expect(httpFetch.mock.calls.map(([url]) => url).sort()).toEqual([
      'https://api.fish.audio/model?page_size=100&language=zh&sort_by=task_count',
      'https://api.fish.audio/model?self=true&page_size=100',
    ])
    expect(voices).toEqual([
      { id: 'mine', name: '我的声音', description: '我的声线' },
      { id: 'popular', name: '温柔女声', description: 'female、温柔' },
    ])
  })

  it('验证连接时查询 API 余额，Key 不对时报错', async () => {
    httpFetch.mockResolvedValueOnce(new Response('No permission -- see authorization schemes', { status: 401 }))
    await expect(validateFishAudio(provider({ apiKey: 'wrong' }))).rejects.toThrow('Fish Audio 接口出错（HTTP 401）：API Key 无效（No permission -- see authorization schemes）')

    const [url, init] = httpFetch.mock.calls[0]!
    expect(url).toBe('https://api.fish.audio/wallet/self/api-credit')
    expect(headersOf(init).Authorization).toBe('Bearer wrong')
  })
})
