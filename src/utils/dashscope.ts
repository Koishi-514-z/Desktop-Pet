import type { SpeechModel, TranscriptionModel } from 'ai'
import type { Provider, ProviderCategory, ProviderModel } from '@/stores/providers'
import { httpFetch } from '@/utils/http'

/**
 * 阿里云百炼（千问）的语音合成与语音识别。
 *
 * 千问的语音接口与 OpenAI 不兼容（没有 /audio/speech、/audio/transcriptions），使用百炼原生的
 * /api/v1/services/aigc/multimodal-generation/generation 接口。这里把它们实现为 AI SDK 的语音合成 / 语音识别模型，
 * 上层照常使用 generateSpeech / transcribe，语音管线不需要区分服务商。
 *
 * 请求通过 Rust 端发出（httpFetch）：百炼的接口与返回的音频文件（OSS）不一定允许浏览器跨域访问。
 */

type SpeechModelV3 = Extract<SpeechModel, { specificationVersion: 'v3' }>
type TranscriptionModelV3 = Extract<TranscriptionModel, { specificationVersion: 'v3' }>

const GENERATION_PATH = '/api/v1/services/aigc/multimodal-generation/generation'
const COMPATIBLE_PATH = '/compatible-mode/v1'

// 千问语音合成每次最多 600 个字
const TTS_MAX_TEXT = 600
export const DEFAULT_TTS_MODEL = 'qwen3-tts-flash'
export const DEFAULT_ASR_MODEL = 'qwen3-asr-flash'
export const DEFAULT_TTS_VOICE = 'Cherry'

/** 接口的根地址：去掉可能填写的 /compatible-mode/v1、/api/v1 后缀，两种写法都可以 */
export function dashscopeRoot(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/(compatible-mode\/v1|api\/v1)$/, '')
}

/** OpenAI 兼容接口的地址（用于获取模型列表） */
export function dashscopeCompatibleUrl(baseUrl: string): string {
  return dashscopeRoot(baseUrl) + COMPATIBLE_PATH
}

// 只能通过 WebSocket 调用的实时模型（-realtime）与异步的录音文件转写（-filetrans）用不了，不列出
const UNSUPPORTED_MODEL_PATTERN = /realtime|filetrans/i

/** 从接口返回的模型中挑出可用的语音合成 / 语音识别模型；列表里没有时加上官方文档中的模型 */
export function dashscopeModels(ids: string[], category: ProviderCategory): ProviderModel[] {
  const keyword = category === 'asr' ? /asr/i : /tts/i
  const fallback = category === 'asr' ? DEFAULT_ASR_MODEL : DEFAULT_TTS_MODEL
  const usable = ids.filter((id) => keyword.test(id) && !UNSUPPORTED_MODEL_PATTERN.test(id))
  if (!usable.includes(fallback)) usable.unshift(fallback)
  return usable.map((id) => ({ id, name: id }))
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0))
}

interface GenerationResponse {
  code?: string
  message?: string
  output?: {
    audio?: { data?: string, url?: string }
    choices?: { message?: { content?: unknown, annotations?: { language?: string }[] } }[]
  }
}

async function postGeneration(provider: Provider, body: unknown, abortSignal?: AbortSignal): Promise<GenerationResponse> {
  const response = await httpFetch(dashscopeRoot(provider.baseUrl) + GENERATION_PATH, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: abortSignal,
  })
  const json = await response.json().catch(() => null) as GenerationResponse | null
  // 成功时 code 为空字符串；出错时为错误码，如 InvalidApiKey
  if (!response.ok || !json || json.code) {
    throw new Error(`千问接口出错（HTTP ${response.status}）：${json?.message || json?.code || response.statusText || '无法解析返回内容'}`)
  }
  return json
}

/** 千问语音合成（如 qwen3-tts-flash），返回 WAV 音频 */
export function createDashScopeSpeechModel(provider: Provider): SpeechModelV3 {
  const modelId = provider.selectedModelId || DEFAULT_TTS_MODEL
  return {
    specificationVersion: 'v3',
    provider: 'dashscope',
    modelId,
    async doGenerate({ text, voice, abortSignal }) {
      if (text.length > TTS_MAX_TEXT) console.warn(`千问语音合成一次最多 ${TTS_MAX_TEXT} 字，超出的部分不会读出来`)
      const json = await postGeneration(provider, {
        model: modelId,
        input: { text: text.slice(0, TTS_MAX_TEXT), voice: voice || DEFAULT_TTS_VOICE },
      }, abortSignal)

      // 音频可能直接以 base64 返回，也可能只给一个下载地址（有效期 24 小时）
      const audio = json.output?.audio
      let bytes: Uint8Array
      if (audio?.data) {
        bytes = fromBase64(audio.data)
      }
      else if (audio?.url) {
        const download = await httpFetch(audio.url, { signal: abortSignal })
        if (!download.ok) throw new Error(`下载千问合成的音频失败（HTTP ${download.status}）`)
        bytes = new Uint8Array(await download.arrayBuffer())
      }
      else {
        throw new Error('千问接口没有返回音频')
      }
      return { audio: bytes, warnings: [], response: { timestamp: new Date(), modelId } }
    },
  }
}

/** 千问语音识别（如 qwen3-asr-flash）：录音以 data URL 的形式随请求一起发送（不超过 10 MB） */
export function createDashScopeTranscriptionModel(provider: Provider): TranscriptionModelV3 {
  const modelId = provider.selectedModelId || DEFAULT_ASR_MODEL
  return {
    specificationVersion: 'v3',
    provider: 'dashscope',
    modelId,
    async doGenerate({ audio, mediaType, abortSignal }) {
      const data = typeof audio === 'string' ? audio : toBase64(audio)
      const json = await postGeneration(provider, {
        model: modelId,
        input: { messages: [{ role: 'user', content: [{ audio: `data:${mediaType};base64,${data}` }] }] },
      }, abortSignal)

      const message = json.output?.choices?.[0]?.message
      const content = message?.content
      const text = Array.isArray(content)
        ? content.map((part: { text?: string }) => part?.text ?? '').join('')
        : typeof content === 'string' ? content : ''
      return {
        text: text.trim(),
        segments: [],
        language: message?.annotations?.find((annotation) => annotation.language)?.language,
        durationInSeconds: undefined,
        warnings: [],
        response: { timestamp: new Date(), modelId },
      }
    },
  }
}
