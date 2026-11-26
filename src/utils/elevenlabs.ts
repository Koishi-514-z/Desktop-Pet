import type { Provider, ProviderVoice } from '@/stores/providers'
import { httpFetch } from '@/utils/http'

/**
 * ElevenLabs 的声线管理（语音合成本身用 @ai-sdk/elevenlabs）：查询可用的声线、删除自己的音色。
 * 请求通过 Rust 端发出（httpFetch），不受跨域限制
 */
export const ELEVENLABS_API = 'https://api.elevenlabs.io'

// GET /v1/voices 返回的声线（只列出用到的字段）
export interface ElevenLabsVoice {
  voice_id: string
  name: string
  // premade 为官方预置；cloned / generated / professional 等是账号里的音色（自己克隆、设计的，或从 Voice Library 加入 My Voices 的）
  category?: string
  // 是不是自己创建的（从 Voice Library 加入的为 false）
  is_owner?: boolean | null
}

/** 接口返回的声线 → 设置页里的声线：账号里自己的音色标注出来，可以删除；官方预置的不能删 */
export function toProviderVoice(voice: ElevenLabsVoice): ProviderVoice {
  if (voice.category === 'premade') return { id: voice.voice_id, name: voice.name }
  return {
    id: voice.voice_id,
    name: voice.name,
    description: voice.is_owner ? '我的音色 · 自己创建' : '我的音色 · 来自 Voice Library',
    deletable: true,
  }
}

// 从出错的响应中取出说明：{ detail: { message } }、{ detail: [{ msg }] } 或 { detail: '...' }
async function errorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  try {
    const { detail } = JSON.parse(text) as { detail?: unknown }
    if (typeof detail === 'string') return detail
    if (Array.isArray(detail)) return detail.map((item: { msg?: string }) => item?.msg).filter(Boolean).join('；')
    if (detail && typeof detail === 'object' && 'message' in detail) return String((detail as { message: unknown }).message)
  }
  catch {
    // 不是 JSON，直接用原文
  }
  return text.slice(0, 200) || res.statusText
}

async function request(provider: Pick<Provider, 'apiKey'>, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await httpFetch(`${ELEVENLABS_API}${path}`, {
    ...init,
    headers: { 'xi-api-key': provider.apiKey, ...init.headers },
  })
  if (!res.ok) {
    const hint = res.status === 401 ? '（API Key 无效，或没有管理音色的权限）' : ''
    throw new Error(`ElevenLabs 接口出错（HTTP ${res.status}）${hint}：${await errorMessage(res)}`)
  }
  return res
}

/** 账号可用的全部声线：官方预置的，以及 My Voices 里的音色 */
export async function listElevenLabsVoices(provider: Pick<Provider, 'apiKey'>): Promise<ProviderVoice[]> {
  const res = await request(provider, '/v1/voices')
  const { voices } = await res.json() as { voices?: ElevenLabsVoice[] }
  return (voices ?? []).filter((voice) => voice?.voice_id).map(toProviderVoice)
}

/** 从账号的 My Voices 里删除一个音色（自己创建的音色删除后无法恢复） */
export async function deleteElevenLabsVoice(provider: Pick<Provider, 'apiKey'>, voiceId: string): Promise<void> {
  await request(provider, `/v1/voices/${encodeURIComponent(voiceId)}`, { method: 'DELETE' })
}
