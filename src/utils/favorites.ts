import type { AudioClip } from '@/utils/reply-audio'
import { FAVORITES_STORE, withStore } from '@/utils/db'
import { encodeWav } from '@/utils/voice-activity'

/**
 * 收藏的桌宠语音：在字幕上收藏的回复，连同它的语音一起保存在 IndexedDB 中。
 * 自定义的排列顺序单独保存（见 stores/favorites.ts），调整顺序时不用重写音频数据。
 */

export interface Favorite {
  id: string
  /** 显示的文字（去掉了情绪标签） */
  text: string
  /** 说这句话的角色 */
  personaName: string
  /** 合成语音的服务 */
  voice?: string
  mediaType: string
  data: Blob
  size: number
  /** 时长（秒），读取不到时为 0 */
  duration: number
  createdAt: number
}

export function createFavoriteId(): string {
  const random = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    : Math.random().toString(36).slice(2, 14)
  return `fav_${random}`
}

export async function addFavorite(favorite: Favorite): Promise<void> {
  await withStore(FAVORITES_STORE, 'readwrite', (store) => store.put(favorite))
}

export async function listFavorites(): Promise<Favorite[]> {
  return (await withStore<Favorite[]>(FAVORITES_STORE, 'readonly', (store) => store.getAll())) ?? []
}

export async function deleteFavorites(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await withStore(FAVORITES_STORE, 'readwrite', (store) => {
    ids.forEach((id) => store.delete(id))
  })
}

// ===== 把一条回复的几句语音拼成一个音频文件 =====

/** 合并后的采样率：语音用 24 kHz 足够，文件也小一些 */
export const MERGE_SAMPLE_RATE = 24_000
/** 句子之间的停顿（秒） */
const GAP_SECONDS = 0.15

export interface MergedAudio {
  data: Uint8Array
  mediaType: string
  /** 合并后的时长（秒）；只有一句、原样保存时为 undefined，需要另外读取 */
  duration?: number
}

/** 解码一句语音，返回指定采样率的单声道采样 */
export type AudioDecoder = (clip: AudioClip, sampleRate: number) => Promise<Float32Array>

/** 用浏览器解码（mp3、wav、ogg 等），重采样为指定的采样率并混成单声道 */
async function decodeClip(clip: AudioClip, sampleRate: number): Promise<Float32Array> {
  const context = new OfflineAudioContext(1, 1, sampleRate)
  // decodeAudioData 会占用传入的数据，复制一份
  const buffer = await context.decodeAudioData(clip.uint8Array.slice().buffer)
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice()
  const mixed = new Float32Array(buffer.length)
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel)
    for (let i = 0; i < data.length; i++) mixed[i]! += data[i]! / buffer.numberOfChannels
  }
  return mixed
}

/**
 * 把几句语音拼成一个音频文件：只有一句时原样保存（保留原来的格式）；
 * 有多句时解码后依次拼接（句间加上短暂的停顿），编码为 WAV。
 * 语音服务输出的 mp3 等格式各自带着文件头，直接把字节接起来时时长会算错，因此解码后重新编码
 */
export async function mergeSpeechAudio(clips: AudioClip[], decode: AudioDecoder = decodeClip): Promise<MergedAudio> {
  if (clips.length === 0) throw new Error('没有语音')
  if (clips.length === 1) return { data: clips[0]!.uint8Array, mediaType: clips[0]!.mediaType || 'audio/mpeg' }

  const parts: Float32Array[] = []
  for (const clip of clips) parts.push(await decode(clip, MERGE_SAMPLE_RATE))
  const gap = Math.round(GAP_SECONDS * MERGE_SAMPLE_RATE)
  const total = parts.reduce((sum, part) => sum + part.length, 0) + gap * (parts.length - 1)
  const samples = new Float32Array(total)
  let offset = 0
  parts.forEach((part, index) => {
    samples.set(part, offset)
    offset += part.length + (index < parts.length - 1 ? gap : 0)
  })
  return { data: encodeWav(samples, MERGE_SAMPLE_RATE), mediaType: 'audio/wav', duration: total / MERGE_SAMPLE_RATE }
}
