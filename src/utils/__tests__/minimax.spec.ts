import type { Provider } from '@/stores/providers'
import { APICallError, experimental_generateSpeech as generateSpeech } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const httpFetch = vi.hoisted(() => vi.fn<(input: string, init?: RequestInit) => Promise<Response>>())
vi.mock('@/utils/http', () => ({ httpFetch }))

import { createMiniMaxSpeechModel, deleteMiniMaxVoice, listMiniMaxVoices, minimaxRoot, validateMiniMax } from '@/utils/minimax'

function provider(patch: Partial<Provider> = {}): Provider {
  return {
    id: 'minimax', name: 'MiniMax', category: 'tts', protocol: 'minimax', baseUrl: 'https://api.minimaxi.com/v1/',
    apiKey: 'sk-test', models: [], selectedModelId: 'speech-2.8-turbo', selectedVoiceId: 'female-shaonv', isValid: true,
    validator: async () => true, listModels: async () => [], ...patch,
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const OK = { status_code: 0, status_msg: 'success' }
// 以 MP3 帧头开头的几个字节
const MP3 = Uint8Array.from([0xFF, 0xFB, 0x90, 0x64, 0x00, 0x0F, 0xF0, 0xAB])
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

beforeEach(() => {
  httpFetch.mockReset()
})

describe('MiniMax 的地址', () => {
  it('Base URL 可以带 /v1，也可以只写根地址', () => {
    expect(minimaxRoot('https://api.minimaxi.com/v1/')).toBe('https://api.minimaxi.com')
    expect(minimaxRoot(' https://api.minimax.io ')).toBe('https://api.minimax.io')
  })
})

describe('MiniMax 语音合成', () => {
  it('调用 T2A v2 接口，把十六进制的音频转换为字节', async () => {
    httpFetch.mockResolvedValueOnce(json({ data: { audio: hex(MP3), status: 2 }, trace_id: 'trace', base_resp: OK }))
    const { audio } = await generateSpeech({ model: createMiniMaxSpeechModel(provider()), text: '你好呀', voice: 'female-shaonv' })

    const [url, init] = httpFetch.mock.calls[0]!
    expect(url).toBe('https://api.minimaxi.com/v1/t2a_v2')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
    expect(JSON.parse(init?.body as string)).toEqual({
      model: 'speech-2.8-turbo',
      text: '你好呀',
      stream: false,
      voice_setting: { voice_id: 'female-shaonv', speed: 1, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
      language_boost: 'auto',
      output_format: 'hex',
    })
    expect(audio.uint8Array).toEqual(MP3)
    expect(audio.mediaType).toBe('audio/mpeg')
  })

  it('没有选模型、声线时用默认的；超过 10000 字的部分截掉；语速与输出格式按调用参数设置', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    httpFetch.mockResolvedValueOnce(json({ data: { audio: hex(MP3).toUpperCase() }, base_resp: OK }))
    const { audio } = await generateSpeech({
      model: createMiniMaxSpeechModel(provider({ selectedModelId: '' })),
      text: '啊'.repeat(10_500),
      speed: 3,
      outputFormat: 'wav',
    })

    const body = JSON.parse(httpFetch.mock.calls[0]![1]?.body as string)
    expect(body.model).toBe('speech-2.8-hd')
    expect(body.voice_setting.voice_id).toBe('male-qn-qingse')
    expect(body.voice_setting.speed).toBe(2)
    expect(body.audio_setting.format).toBe('wav')
    expect(body.text).toHaveLength(10_000)
    expect(audio.uint8Array).toEqual(MP3)
    vi.restoreAllMocks()
  })

  it('HTTP 状态码是 200 但 base_resp 报错时说明原因；限流的错误交给 AI SDK 重试', async () => {
    httpFetch.mockResolvedValueOnce(json({ base_resp: { status_code: 2049, status_msg: 'invalid api key' } }))
    const invalidKey = await generateSpeech({ model: createMiniMaxSpeechModel(provider()), text: '你好', maxRetries: 0 }).catch((error) => error)
    expect(invalidKey.message).toBe('MiniMax 接口出错（错误码 2049）：API Key 无效；国内站与国际站的 Key 不通用，Base URL 要与 Key 所属的站点一致（invalid api key）')
    expect(APICallError.isInstance(invalidKey) && invalidKey.isRetryable).toBe(false)

    httpFetch.mockResolvedValueOnce(json({ base_resp: { status_code: 1002, status_msg: 'rate limit exceeded(RPM)' } }))
    const rateLimited = await generateSpeech({ model: createMiniMaxSpeechModel(provider()), text: '你好', maxRetries: 0 }).catch((error) => error)
    expect(APICallError.isInstance(rateLimited) && rateLimited.isRetryable).toBe(true)

    httpFetch.mockResolvedValueOnce(json({ data: { audio: '' }, base_resp: OK }))
    await expect(generateSpeech({ model: createMiniMaxSpeechModel(provider()), text: '你好', maxRetries: 0 }))
      .rejects.toThrow('MiniMax 接口没有返回音频')
  })
})

describe('MiniMax 声线', () => {
  it('列出复刻、文生与系统音色，自己的音色排在前面，记下类别、可以删除', async () => {
    httpFetch.mockResolvedValueOnce(json({
      system_voice: [
        { voice_id: 'male-qn-qingse', voice_name: '青涩青年音色', description: ['温润青年男声'] },
        { voice_id: 'Chinese (Mandarin)_Lyrical_Voice', voice_name: '抒情男声', description: [] },
      ],
      voice_cloning: [{ voice_id: 'my-voice', description: [], created_time: '2026-11-25' }],
      voice_generation: [{ voice_id: 'designed', description: ['活泼少女'], created_time: '2026-11-26' }],
      base_resp: OK,
    }))
    const voices = await listMiniMaxVoices(provider())

    const [url, init] = httpFetch.mock.calls[0]!
    expect(url).toBe('https://api.minimaxi.com/v1/get_voice')
    expect(JSON.parse(init?.body as string)).toEqual({ voice_type: 'all' })
    expect(voices).toEqual([
      { id: 'my-voice', name: 'my-voice', description: '快速复刻的音色', kind: 'voice_cloning', deletable: true },
      { id: 'designed', name: 'designed', description: '文生音色：活泼少女', kind: 'voice_generation', deletable: true },
      { id: 'male-qn-qingse', name: '青涩青年音色', description: '温润青年男声' },
      { id: 'Chinese (Mandarin)_Lyrical_Voice', name: '抒情男声', description: undefined },
    ])
  })

  it('验证连接时 Key 不对会报错', async () => {
    httpFetch.mockResolvedValueOnce(json({
      base_resp: { status_code: 1004, status_msg: 'login fail: Please carry the API secret key in the \'Authorization\' field of the request header' },
    }))
    await expect(validateMiniMax(provider({ apiKey: '' }))).rejects.toThrow('MiniMax 接口出错（错误码 1004）：鉴权失败')
  })

  it('删除音色：带上列表中记下的类别', async () => {
    httpFetch.mockResolvedValueOnce(json({ voice_id: 'designed', created_time: '1728962464', base_resp: OK }))
    await deleteMiniMaxVoice(provider(), { id: 'designed', kind: 'voice_generation' })

    const [url, init] = httpFetch.mock.calls[0]!
    expect(url).toBe('https://api.minimaxi.com/v1/delete_voice')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ voice_type: 'voice_generation', voice_id: 'designed' })
  })

  it('系统音色（没有类别）不发请求；接口出错时给出原因', async () => {
    await expect(deleteMiniMaxVoice(provider(), { id: 'male-qn-qingse' })).rejects.toThrow('系统音色不能删除')
    expect(httpFetch).not.toHaveBeenCalled()

    httpFetch.mockResolvedValueOnce(json({ base_resp: { status_code: 2013, status_msg: 'invalid params, voice_id not exist' } }))
    await expect(deleteMiniMaxVoice(provider(), { id: 'gone', kind: 'voice_cloning' })).rejects.toThrow('MiniMax 接口出错（错误码 2013）')
  })
})
