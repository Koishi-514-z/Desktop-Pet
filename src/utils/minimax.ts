import type { SpeechModel } from 'ai'
import type { Provider, ProviderModel, ProviderVoice } from '@/stores/providers'
import { APICallError } from 'ai'
import { httpFetch } from '@/utils/http'
import { clamp } from '@/utils/math'

/**
 * MiniMax 的语音合成（T2A v2）。
 *
 * MiniMax 的语音接口是自家的协议，与 OpenAI 不兼容：POST {Base URL}/v1/t2a_v2，Bearer 鉴权，
 * 音频以十六进制字符串放在返回的 JSON 中；出错时 HTTP 状态码一般仍是 200，错误码在 base_resp.status_code 里。
 * 这里把它实现为 AI SDK 的语音合成模型，上层照常使用 generateSpeech，语音管线不需要区分服务商。
 *
 * 国内站（platform.minimaxi.com）与国际站（platform.minimax.io）的账号、API Key 不通用，
 * Base URL 分别为 https://api.minimaxi.com 与 https://api.minimax.io。
 *
 * 请求通过 Rust 端发出（httpFetch），不受浏览器跨域限制。
 */

type SpeechModelV3 = Extract<SpeechModel, { specificationVersion: 'v3' }>

const T2A_PATH = '/v1/t2a_v2'
const VOICE_PATH = '/v1/get_voice'

// 非流式合成一次最多 10000 字
const TTS_MAX_TEXT = 10_000
export const DEFAULT_TTS_MODEL = 'speech-2.8-hd'
export const DEFAULT_TTS_VOICE = 'male-qn-qingse'

// 语音合成模型，见 MiniMax 文档「同步语音合成」：hd 音质更好，turbo 更快、更便宜
export const MINIMAX_TTS_MODELS: ProviderModel[] = [
  { id: 'speech-2.8-hd', name: 'Speech 2.8 HD', description: '最新，音质最好' },
  { id: 'speech-2.8-turbo', name: 'Speech 2.8 Turbo', description: '最新，更快、更便宜' },
  { id: 'speech-2.6-hd', name: 'Speech 2.6 HD' },
  { id: 'speech-2.6-turbo', name: 'Speech 2.6 Turbo' },
  { id: 'speech-02-hd', name: 'Speech 02 HD' },
  { id: 'speech-02-turbo', name: 'Speech 02 Turbo' },
  { id: 'speech-01-hd', name: 'Speech 01 HD' },
  { id: 'speech-01-turbo', name: 'Speech 01 Turbo' },
]

// 可以输出的、带文件头的音频格式（pcm 等裸数据无法直接播放）
const OUTPUT_FORMATS = ['mp3', 'wav', 'flac']

/** 接口的根地址：去掉末尾的 / 与可能填写的 /v1，两种写法都可以 */
export function minimaxRoot(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '')
}

interface MiniMaxResponse {
  base_resp?: { status_code?: number, status_msg?: string } | null
}

interface T2AResponse extends MiniMaxResponse {
  data?: { audio?: string, status?: number } | null
}

interface VoiceInfo {
  voice_id?: string
  voice_name?: string
  description?: string[] | null
}

interface GetVoiceResponse extends MiniMaxResponse {
  system_voice?: VoiceInfo[] | null
  voice_cloning?: VoiceInfo[] | null
  voice_generation?: VoiceInfo[] | null
}

const KEY_REGION_HINT = '国内站与国际站的 Key 不通用，Base URL 要与 Key 所属的站点一致'

// 常见错误码的说明（接口返回的 status_msg 是英文）
const ERROR_HINTS: Record<number, string> = {
  1002: '请求太频繁，触发了限流',
  1004: `鉴权失败，请检查 API Key；${KEY_REGION_HINT}`,
  1008: '账户余额不足',
  1039: '超出了每分钟的字数上限（TPM）',
  2013: '参数错误，请检查所选的模型与声线',
  2049: `API Key 无效；${KEY_REGION_HINT}`,
}

// 稍后重试可能成功的错误：未知错误、超时、限流
const RETRYABLE_CODES = new Set([1000, 1001, 1002, 1039])

async function postMiniMax<T extends MiniMaxResponse>(
  provider: Provider,
  path: string,
  body: Record<string, unknown>,
  abortSignal?: AbortSignal,
): Promise<T> {
  const url = minimaxRoot(provider.baseUrl) + path
  const response = await httpFetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: abortSignal,
  })
  const json = await response.json().catch(() => null) as T | null
  // status_code 为 0 表示成功
  const code = json?.base_resp?.status_code ?? 0
  if (response.ok && json && code === 0) return json

  const reason = json?.base_resp?.status_msg || response.statusText || '无法解析返回内容'
  const hint = ERROR_HINTS[code]
  // 抛出 APICallError，限流等错误会由 AI SDK 自动重试
  throw new APICallError({
    message: `MiniMax 接口出错（${code ? `错误码 ${code}` : `HTTP ${response.status}`}）：${hint ? `${hint}（${reason}）` : reason}`,
    url,
    requestBodyValues: body,
    statusCode: response.status,
    isRetryable: RETRYABLE_CODES.has(code) || response.status === 429 || response.status >= 500,
  })
}

// '0'-'9' 对应 0-9，'a'-'f' 与 'A'-'F' 对应 10-15
function hexDigit(charCode: number): number {
  return charCode <= 57 ? charCode - 48 : (charCode | 32) - 87
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error('MiniMax 返回的音频不是有效的十六进制数据')
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = (hexDigit(hex.charCodeAt(i * 2)) << 4) | hexDigit(hex.charCodeAt(i * 2 + 1))
  }
  return bytes
}

/** MiniMax 语音合成（如 speech-2.8-hd），默认返回 MP3 音频 */
export function createMiniMaxSpeechModel(provider: Provider): SpeechModelV3 {
  const modelId = provider.selectedModelId || DEFAULT_TTS_MODEL
  return {
    specificationVersion: 'v3',
    provider: 'minimax',
    modelId,
    async doGenerate({ text, voice, outputFormat, speed, abortSignal }) {
      if (text.length > TTS_MAX_TEXT) console.warn(`MiniMax 语音合成一次最多 ${TTS_MAX_TEXT} 字，超出的部分不会读出来`)
      const json = await postMiniMax<T2AResponse>(provider, T2A_PATH, {
        model: modelId,
        text: text.slice(0, TTS_MAX_TEXT),
        stream: false,
        voice_setting: { voice_id: voice || DEFAULT_TTS_VOICE, speed: clamp(speed ?? 1, 0.5, 2), vol: 1, pitch: 0 },
        audio_setting: {
          sample_rate: 32000,
          bitrate: 128000,
          format: outputFormat && OUTPUT_FORMATS.includes(outputFormat) ? outputFormat : 'mp3',
          channel: 1,
        },
        // 自动判断语种（中英混读、方言等）
        language_boost: 'auto',
        output_format: 'hex',
      }, abortSignal)

      const hex = json.data?.audio
      if (!hex) throw new Error('MiniMax 接口没有返回音频')
      return { audio: fromHex(hex), warnings: [], response: { timestamp: new Date(), modelId } }
    },
  }
}

/** 检查 API Key 与 Base URL 是否可用（查询一次系统音色），不可用时抛出错误 */
export async function validateMiniMax(provider: Provider): Promise<void> {
  await postMiniMax(provider, VOICE_PATH, { voice_type: 'system' })
}

/** 账号可用的全部声线：自己复刻、文生的音色在前，系统音色在后 */
export async function listMiniMaxVoices(provider: Provider): Promise<ProviderVoice[]> {
  const json = await postMiniMax<GetVoiceResponse>(provider, VOICE_PATH, { voice_type: 'all' })
  const voices = new Map<string, ProviderVoice>()
  const add = (items: VoiceInfo[] | null | undefined, label?: string) => {
    for (const item of items ?? []) {
      if (!item?.voice_id || voices.has(item.voice_id)) continue
      const text = (item.description ?? []).filter(Boolean).join(' ')
      voices.set(item.voice_id, {
        id: item.voice_id,
        name: item.voice_name || item.voice_id,
        description: label ? (text ? `${label}：${text}` : label) : text || undefined,
      })
    }
  }
  add(json.voice_cloning, '快速复刻的音色')
  add(json.voice_generation, '文生音色')
  add(json.system_voice)
  return [...voices.values()]
}
