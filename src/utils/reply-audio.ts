import { toRaw } from 'vue'

/**
 * 最近几条回复的语音（只在内存中）：语音管线合成好一句，就按顺序记在这句话所属的回复名下，
 * 在字幕上收藏时直接拼起来保存，不用重新合成。只保留最近的几条，免得长时间对话占用太多内存。
 */

/** 一句话的语音 */
export interface AudioClip {
  uint8Array: Uint8Array
  mediaType: string
}

export interface ReplyAudio {
  clips: AudioClip[]
  /** 说这些话的角色 */
  personaName: string
  /** 合成语音的服务 */
  voice?: string
}

/** 最多保留几条回复的语音 */
export const MAX_CACHED_REPLIES = 30

// 键为会话中的消息对象（转为原始对象，响应式代理与原始对象对应同一条）；Map 按插入顺序排列，超出时去掉最早的
const cache = new Map<object, ReplyAudio>()

/** 记下一句话的语音；owner 为这句话所属的回复 */
export function recordReplyAudio(owner: object, clip: AudioClip, info: Omit<ReplyAudio, 'clips'>): void {
  const key = toRaw(owner)
  let reply = cache.get(key)
  if (!reply) {
    reply = { clips: [], ...info }
    cache.set(key, reply)
    while (cache.size > MAX_CACHED_REPLIES) cache.delete(cache.keys().next().value!)
  }
  reply.clips.push({ uint8Array: clip.uint8Array, mediaType: clip.mediaType })
}

/** 这条回复的语音；不在缓存中（如很早以前的回复、重新打开了应用）时为 undefined */
export function getReplyAudio(owner: object): ReplyAudio | undefined {
  return cache.get(toRaw(owner))
}

export function clearReplyAudio(): void {
  cache.clear()
}
