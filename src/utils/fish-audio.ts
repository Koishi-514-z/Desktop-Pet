import type { SpeechModel, TranscriptionModel } from 'ai'
import type { Provider, ProviderModel, ProviderVoice } from '@/stores/providers'
import { APICallError } from 'ai'
import { httpFetch } from '@/utils/http'
import { clamp } from '@/utils/math'

/**
 * Fish Audio 的语音合成与语音识别。
 *
 * Fish Audio 的接口是自家的协议，与 OpenAI 不兼容：
 * - 语音合成：POST /v1/tts，模型放在请求头 model 中，声线是 reference_id（声线模型的 id），直接返回音频；
 * - 语音识别：POST /v1/asr，录音以 multipart 表单上传，返回 JSON；
 * - 声线：GET /model 查询声线模型（公开的声线库与自己创建的声线）。
 * 出错时返回 4xx / 5xx 状态码与 { status, message } 形式的 JSON。
 * 这里把它们实现为 AI SDK 的模型，上层照常使用 generateSpeech / transcribe，语音管线不需要区分服务商。
 *
 * 请求通过 Rust 端发出（httpFetch），不受浏览器跨域限制。
 */

type SpeechModelV3 = Extract<SpeechModel, { specificationVersion: 'v3' }>
type TranscriptionModelV3 = Extract<TranscriptionModel, { specificationVersion: 'v3' }>

// 只有官方的接口地址，不需要配置 Base URL
export const FISH_AUDIO_API = 'https://api.fish.audio'

export const DEFAULT_TTS_MODEL = 's2.1-pro'
export const DEFAULT_ASR_MODEL = 'transcribe-1'

// 语音合成模型（请求头 model），见 Fish Audio 文档「Models Overview」。不指定或写错时服务端改用 s2.1-pro，不会报错
export const FISH_AUDIO_TTS_MODELS: ProviderModel[] = [
  { id: 's2.1-pro', name: 'S2.1 Pro', description: '推荐，支持 83 种语言' },
  { id: 's2.1-pro-free', name: 'S2.1 Pro Free', description: '与 S2.1 Pro 相同，免费，但有用量限制、不保证速度' },
  { id: 's2-pro', name: 'S2 Pro', description: '上一代' },
  { id: 'drama-3', name: 'Drama 3', description: '可以在文字中用方括号指示语气，价格较高' },
]

// 语音识别模型（价格相同）
export const FISH_AUDIO_ASR_MODELS: ProviderModel[] = [
  { id: 'transcribe-1', name: 'Transcribe 1', description: '适合短录音（语音输入）' },
  { id: 'transcribe-1-pro', name: 'Transcribe 1 Pro', description: '支持长录音与多人对话' },
]

// 同一账号能同时进行的请求数有限（入门档为 5 个，所有 Key 共用），超出时返回 429。
// 长回复会一次切出好几句话并行合成，这里让多出来的请求排队，并给语音识别留出余量
export const FISH_AUDIO_MAX_CONCURRENCY = 4

let activeRequests = 0
const waitingRequests: (() => void)[] = []

async function withSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeRequests < FISH_AUDIO_MAX_CONCURRENCY) activeRequests++
  // 前面的请求完成时把名额直接交给排队的请求，activeRequests 不变
  else await new Promise<void>((resolve) => waitingRequests.push(resolve))
  try {
    return await task()
  }
  finally {
    const next = waitingRequests.shift()
    if (next) next()
    else activeRequests--
  }
}

// 常见错误的说明（接口返回的 message 是英文）
const ERROR_HINTS: Record<number, string> = {
  401: 'API Key 无效',
  402: 'API 余额不足',
  429: '同时进行的请求太多（同一账号的所有 Key 共用并发数）',
}

/** 发出请求，出错时抛出 APICallError（429、5xx 会由 AI SDK 自动重试） */
async function fishFetch(provider: Provider, path: string, init: RequestInit, requestBodyValues?: unknown): Promise<Response> {
  const url = FISH_AUDIO_API + path
  const response = await httpFetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${provider.apiKey}`, ...(init.headers as Record<string, string> | undefined) },
  })
  if (response.ok) return response

  const responseBody = await response.text().catch(() => '')
  let message = ''
  try {
    message = (JSON.parse(responseBody) as { message?: string }).message ?? ''
  }
  catch {
    // 有的错误（如鉴权失败）返回的是纯文本
  }
  const reason = message || responseBody.slice(0, 200) || response.statusText || '无法解析返回内容'
  const hint = ERROR_HINTS[response.status]
  throw new APICallError({
    message: `Fish Audio 接口出错（HTTP ${response.status}）：${hint ? `${hint}（${reason}）` : reason}`,
    url,
    requestBodyValues,
    statusCode: response.status,
    responseBody,
  })
}

/** Fish Audio 语音合成，默认返回 MP3 音频 */
export function createFishAudioSpeechModel(provider: Provider): SpeechModelV3 {
  const modelId = provider.selectedModelId || DEFAULT_TTS_MODEL
  return {
    specificationVersion: 'v3',
    provider: 'fish-audio',
    modelId,
    async doGenerate({ text, voice, outputFormat, speed, abortSignal }) {
      const body = {
        text,
        // 没有选声线时不传 reference_id，声音由服务端决定（可能每句都不一样）
        ...(voice ? { reference_id: voice } : {}),
        format: outputFormat === 'wav' ? 'wav' : 'mp3',
        ...(speed !== undefined ? { prosody: { speed: clamp(speed, 0.5, 2) } } : {}),
      }
      // 音频是分块传回来的，读完之后才算请求结束
      const audio = await withSlot(async () => {
        const response = await fishFetch(provider, '/v1/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'model': modelId },
          body: JSON.stringify(body),
          signal: abortSignal,
        }, body)
        if (response.headers.get('Content-Type')?.includes('json')) {
          throw new Error(`Fish Audio 接口没有返回音频：${(await response.text()).slice(0, 200)}`)
        }
        return new Uint8Array(await response.arrayBuffer())
      })
      if (audio.length === 0) throw new Error('Fish Audio 接口没有返回音频')
      return { audio, warnings: [], response: { timestamp: new Date(), modelId } }
    },
  }
}

interface TranscriptionResponse {
  text?: string
  duration?: number
  language_code?: string
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0))
}

/** Fish Audio 语音识别：录音以 multipart 表单上传，格式由服务端根据内容判断 */
export function createFishAudioTranscriptionModel(provider: Provider): TranscriptionModelV3 {
  const modelId = provider.selectedModelId || DEFAULT_ASR_MODEL
  return {
    specificationVersion: 'v3',
    provider: 'fish-audio',
    modelId,
    async doGenerate({ audio, mediaType, abortSignal }) {
      const bytes = typeof audio === 'string' ? fromBase64(audio) : audio
      const form = new FormData()
      form.append('audio', new Blob([new Uint8Array(bytes)], { type: mediaType }), 'audio')
      // 不需要时间戳（短录音加上时间戳会更慢）
      form.append('ignore_timestamps', 'true')
      if (modelId.endsWith('-pro')) {
        // Pro 模型默认会在文字中标出笑声等声音事件、区分说话人，语音输入不需要
        form.append('tag_audio_events', 'false')
        form.append('diarize', 'false')
      }

      const json = await withSlot(async () => {
        const response = await fishFetch(provider, '/v1/asr', {
          method: 'POST',
          headers: { model: modelId },
          body: form,
          signal: abortSignal,
        }, { model: modelId })
        return await response.json() as TranscriptionResponse
      })
      return {
        text: (json.text ?? '').trim(),
        segments: [],
        language: json.language_code,
        durationInSeconds: json.duration,
        warnings: [],
        response: { timestamp: new Date(), modelId },
      }
    },
  }
}

/** 检查 API Key 是否可用（查询一次 API 余额），不可用时抛出错误 */
export async function validateFishAudio(provider: Provider): Promise<void> {
  await fishFetch(provider, '/wallet/self/api-credit', { method: 'GET' })
}

interface VoiceModel {
  _id?: string
  type?: string
  state?: string
  title?: string
  description?: string | null
  tags?: string[] | null
}

async function listVoiceModels(provider: Provider, query: string): Promise<VoiceModel[]> {
  const response = await fishFetch(provider, `/model?${query}`, { method: 'GET' })
  const json = await response.json() as { items?: VoiceModel[] | null }
  return json.items ?? []
}

// 不少声线的简介只是一个链接，这时改用标签说明
function describeVoice(voice: VoiceModel): string {
  const description = voice.description?.trim() ?? ''
  if (description && !/^https?:\/\/\S+$/.test(description)) return description
  return (voice.tags ?? []).join('、')
}

/**
 * 可选的声线：自己创建的声线在前，之后是声线库中使用次数最多的 100 个中文声线。
 * 声线库有上百万个声线，无法全部列出
 */
export async function listFishAudioVoices(provider: Provider): Promise<ProviderVoice[]> {
  const [own, popular] = await Promise.all([
    listVoiceModels(provider, 'self=true&page_size=100'),
    listVoiceModels(provider, 'page_size=100&language=zh&sort_by=task_count'),
  ])
  const voices = new Map<string, ProviderVoice>()
  const add = (items: VoiceModel[], label?: string) => {
    for (const item of items) {
      if (!item?._id || voices.has(item._id)) continue
      // 只要能用来合成语音（不是变声模型）、已经训练好的声线
      if ((item.type && item.type !== 'tts') || (item.state && item.state !== 'trained')) continue
      const text = describeVoice(item)
      voices.set(item._id, {
        id: item._id,
        name: item.title || item._id,
        description: label ? (text ? `${label}：${text}` : label) : text || undefined,
      })
    }
  }
  add(own, '我的声线')
  add(popular)
  return [...voices.values()]
}
