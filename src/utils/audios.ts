import type { ModelMessage } from 'ai'
import { messageText } from '@/agent/utils'
import { AUDIOS_STORE, withStore } from '@/utils/db'

/**
 * 对话中的音频文件（「音频理解」技能）：数据保存在 IndexedDB 中，消息里只记录 id、文件名与时长，
 * 并以「【附音频：id｜文件名｜时长】」的标记告诉模型。转录结果也保存在这里，追问时不用重新转录。
 */

/**
 * 「音频理解」技能的 id。定义在这里而不是技能文件中：Agent 的入口按消息中的音频标记预先加载这个技能，
 * 从技能文件引用会形成循环依赖（技能 → agent store → 技能列表）
 */
export const AUDIO_SKILL_ID = 'audio'

/** 转录出的一段话，时间以秒计 */
export interface TranscriptSegment {
  start: number
  end: number
  text: string
}

export interface Transcript {
  /** 用哪个语音识别服务转录的 */
  provider: string
  segments: TranscriptSegment[]
}

export interface StoredAudio {
  id: string
  name: string
  mediaType: string
  size: number
  /** 时长（秒），无法获取时为 0 */
  duration: number
  data: Blob
  createdAt: number
  transcript?: Transcript
}

/** 消息中引用的音频 */
export interface AudioRef {
  id: string
  name: string
  duration: number
  size: number
}

/** 一条消息最多附带几个音频 */
export const MAX_AUDIOS = 3
/** 音频文件最大多少字节 */
export const MAX_AUDIO_BYTES = 300 * 1024 * 1024

const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'webm', 'weba', 'mp4', 'amr']

/** 文件是不是音频（有的系统不给出 m4a 等文件的类型，按扩展名判断） */
export function isAudioFile(file: Pick<File, 'name' | 'type'>): boolean {
  if (file.type.startsWith('audio/')) return true
  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  return AUDIO_EXTENSIONS.includes(extension)
}

export function createAudioId(): string {
  const random = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    : Math.random().toString(36).slice(2, 14)
  return `aud_${random}`
}

/** 用 <audio> 读取时长（只读文件头，不用解码整个文件）；读取不到时为 0 */
export function readAudioDuration(blob: Blob): Promise<number> {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return Promise.resolve(0)
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const audio = document.createElement('audio')
    const done = (duration: number) => {
      URL.revokeObjectURL(url)
      resolve(Number.isFinite(duration) && duration > 0 ? duration : 0)
    }
    audio.preload = 'metadata'
    audio.onloadedmetadata = () => done(audio.duration)
    audio.onerror = () => done(0)
    setTimeout(() => done(0), 10_000)
    audio.src = url
  })
}

/** 保存一个音频文件，返回在消息中引用的信息 */
export async function addAudio(file: Blob, name = (file as File).name || '音频'): Promise<AudioRef> {
  if (file.size > MAX_AUDIO_BYTES) throw new Error(`音频文件太大（超过 ${MAX_AUDIO_BYTES / 1024 / 1024} MB）`)
  const audio: StoredAudio = {
    id: createAudioId(),
    name,
    mediaType: file.type || 'audio/*',
    size: file.size,
    duration: await readAudioDuration(file),
    data: file,
    createdAt: Date.now(),
  }
  await withStore(AUDIOS_STORE, 'readwrite', (store) => store.put(audio))
  return { id: audio.id, name: audio.name, duration: audio.duration, size: audio.size }
}

export async function loadAudio(id: string): Promise<StoredAudio | undefined> {
  return withStore<StoredAudio>(AUDIOS_STORE, 'readonly', (store) => store.get(id))
}

/** 保存转录结果 */
export async function saveTranscript(id: string, transcript: Transcript): Promise<void> {
  const audio = await loadAudio(id)
  if (!audio) return
  await withStore(AUDIOS_STORE, 'readwrite', (store) => store.put({ ...audio, transcript }))
}

export async function deleteAudios(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await withStore(AUDIOS_STORE, 'readwrite', (store) => {
    ids.forEach((id) => store.delete(id))
  })
}

/** 时长，如 1:05:09、3:21 */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

const AUDIO_MARKER_REGEX = /【附音频：([\w-]+)/g

/** 附加在用户消息末尾的音频标记 */
export function audioMarkers(audios: AudioRef[]): string {
  return audios
    .map((audio) => `【附音频：${audio.id}｜${audio.name}${audio.duration ? `｜${formatDuration(audio.duration)}` : ''}】`)
    .join('\n')
}

export function parseAudioIds(text: string): string[] {
  return [...text.matchAll(AUDIO_MARKER_REGEX)].map((match) => match[1]!)
}

/** 对话中最近一条带音频的用户消息中的音频 */
export function findLatestAudioIds(messages: ModelMessage[]): string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role !== 'user') continue
    const ids = parseAudioIds(messageText(message))
    if (ids.length) return ids
  }
  return []
}
