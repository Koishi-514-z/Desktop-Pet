import type { ChatMessage } from '@/stores/chat'
import type { Favorite } from '@/utils/favorites'
import type { AudioClip } from '@/utils/reply-audio'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { clearReplyAudio, recordReplyAudio } from '@/utils/reply-audio'

// 数据库、语音合成、播放与其他 store 都换成模拟的
const mocks = vi.hoisted(() => ({
  saved: new Map<string, Favorite>(),
  speak: vi.fn<(text: string) => Promise<AudioClip | undefined>>(),
  toSpeechText: vi.fn<(text: string) => Promise<string>>(async (text) => text),
  ttsProvider: { name: 'Fish Audio' } as { name: string } | null,
  chat: { isStreaming: false },
  audio: {
    replay: null as { text: string, speaker: string } | null,
    speechPending: false,
    play: vi.fn<(audio: AudioClip) => Promise<void>>(),
    stop: vi.fn<() => void>(),
  },
}))

vi.mock('@/utils/favorites', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/utils/favorites')>()
  return {
    ...original,
    addFavorite: vi.fn<(favorite: Favorite) => Promise<void>>(async (favorite) => void mocks.saved.set(favorite.id, favorite)),
    listFavorites: vi.fn<() => Promise<Favorite[]>>(async () => [...mocks.saved.values()]),
    deleteFavorites: vi.fn<(ids: string[]) => Promise<void>>(async (ids) => ids.forEach((id) => mocks.saved.delete(id))),
    // 测试环境没有 OfflineAudioContext：每句「解码」为 0.5 秒
    mergeSpeechAudio: (clips: AudioClip[]) => original.mergeSpeechAudio(clips, async (_clip, rate) => new Float32Array(rate / 2)),
  }
})
// 测试环境中 <audio> 读不到时长
vi.mock('@/utils/audios', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/utils/audios')>(),
  readAudioDuration: vi.fn<() => Promise<number>>(async () => 2.5),
}))
vi.mock('@/stores/speech', () => ({
  useSpeechStore: () => ({ speak: mocks.speak, toSpeakableText: (text: string) => text.replace(/\[[^\]]+\]/g, '') }),
}))
vi.mock('@/stores/language', () => ({ useLanguageStore: () => ({ toSpeechText: mocks.toSpeechText }) }))
vi.mock('@/stores/providers', () => ({ useProvidersStore: () => ({ getCurrentTTSProvider: () => mocks.ttsProvider }) }))
vi.mock('@/stores/persona', () => ({ usePersonaStore: () => ({ currentPersona: { name: '现在的角色' } }) }))
// 与真实的 store 一样是响应式的（「桌宠是否正在说话」是根据它们计算的）
vi.mock('@/stores/chat', async () => {
  const { reactive } = await import('vue')
  mocks.chat = reactive(mocks.chat)
  return { useChatStore: () => mocks.chat }
})
vi.mock('@/stores/audio', async () => {
  const { reactive } = await import('vue')
  mocks.audio = reactive(mocks.audio)
  return { useAudioStore: () => mocks.audio }
})

import { useFavoritesStore } from '@/stores/favorites'

const clip = (byte: number, mediaType = 'audio/mpeg'): AudioClip => ({ uint8Array: new Uint8Array([byte]), mediaType })

function reply(content: string, rawContent?: string): ChatMessage {
  return reactive<ChatMessage>({ role: 'assistant', content, ...(rawContent ? { rawContent } : {}) })
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  clearReplyAudio()
  mocks.saved.clear()
  mocks.speak.mockReset()
  mocks.toSpeechText.mockClear()
  mocks.ttsProvider = { name: 'Fish Audio' }
  mocks.chat.isStreaming = false
  Object.assign(mocks.audio, { replay: null, speechPending: false })
  mocks.audio.play.mockReset()
  mocks.audio.stop.mockReset()
})

describe('收藏桌宠的回复', () => {
  it('使用刚刚播放过的语音：只有一句时原样保存，记下说话的角色与语音服务', async () => {
    const store = useFavoritesStore()
    const message = reply('早上好呀')
    recordReplyAudio(message, clip(7), { personaName: 'ATRI', voice: 'ElevenLabs' })

    const favorite = await store.favoriteMessage(message)
    expect(favorite).toMatchObject({ text: '早上好呀', personaName: 'ATRI', voice: 'ElevenLabs', mediaType: 'audio/mpeg', size: 1 })
    expect(mocks.speak).not.toHaveBeenCalled()
    expect(mocks.saved.get(favorite.id)).toBe(favorite)
    // 记在消息上（随会话保存），字幕据此显示「已收藏」
    expect(message.favoriteId).toBe(favorite.id)
    expect(store.isFavorited(message)).toBe(true)
    // 再次收藏不会重复保存
    expect(await store.favoriteMessage(message)).toEqual(favorite)
    expect(mocks.saved.size).toBe(1)
  })

  it('有多句时拼成一个 WAV 文件', async () => {
    const store = useFavoritesStore()
    const message = reply('第一句。第二句。')
    recordReplyAudio(message, clip(1), { personaName: 'ATRI' })
    recordReplyAudio(message, clip(2), { personaName: 'ATRI' })
    const favorite = await store.favoriteMessage(message)
    expect(favorite.mediaType).toBe('audio/wav')
    // 两句各 0.5 秒，中间停顿 0.15 秒
    expect(favorite.duration).toBeCloseTo(1.15)
    expect(favorite).not.toHaveProperty('voice')
  })

  it('语音不在缓存中时，用当前的语音服务重新合成整段话（念的语言不同时先翻译）', async () => {
    const store = useFavoritesStore()
    mocks.speak.mockResolvedValue({ uint8Array: new Uint8Array([9, 9]), mediaType: 'audio/mpeg' })
    mocks.toSpeechText.mockImplementation(async (text: string) => `译文：${text}`)
    const message = reply('你好呀', '[happy]你好呀')

    const favorite = await store.favoriteMessage(message)
    expect(mocks.speak).toHaveBeenCalledWith('译文：你好呀')
    expect(favorite).toMatchObject({ personaName: '现在的角色', voice: 'Fish Audio', size: 2 })
  })

  it('无法重新合成时报错，不保存', async () => {
    const store = useFavoritesStore()
    mocks.ttsProvider = null
    await expect(store.favoriteMessage(reply('你好'))).rejects.toThrow('还没有配置语音合成服务')

    mocks.ttsProvider = { name: 'Fish Audio' }
    await expect(store.favoriteMessage(reply('[sighs]', '[sighs]'))).rejects.toThrow('没有要念的内容')
    mocks.speak.mockResolvedValue(undefined)
    await expect(store.favoriteMessage(reply('你好'))).rejects.toThrow('重新合成语音失败')
    expect(mocks.saved.size).toBe(0)
  })

  it('收藏期间标记为正在收藏；取消收藏时删除保存的语音', async () => {
    const store = useFavoritesStore()
    const message = reply('晚安')
    recordReplyAudio(message, clip(1), { personaName: 'ATRI' })
    const saving = store.favoriteMessage(message)
    expect(store.isSaving(message)).toBe(true)
    await saving
    expect(store.isSaving(message)).toBe(false)

    await store.unfavoriteMessage(message)
    expect(message.favoriteId).toBeUndefined()
    expect(store.isFavorited(message)).toBe(false)
    expect(mocks.saved.size).toBe(0)
  })
})

describe('收藏列表', () => {
  async function favoriteAll(store: ReturnType<typeof useFavoritesStore>, texts: string[]) {
    const now = vi.spyOn(Date, 'now')
    const result: Favorite[] = []
    for (const [index, text] of texts.entries()) {
      now.mockReturnValue(1000 + index)
      const message = reply(text)
      recordReplyAudio(message, clip(index), { personaName: 'ATRI' })
      result.push(await store.favoriteMessage(message))
    }
    now.mockRestore()
    return result
  }

  it('新的收藏排在最前面；可以调整自定义顺序，也可以按时间、时长排列', async () => {
    const store = useFavoritesStore()
    const [a, b, c] = await favoriteAll(store, ['一', '二', '三'])
    const texts = () => store.sorted.map((item) => item.text)
    expect(texts()).toEqual(['三', '二', '一'])

    store.move(a!.id, 0)
    expect(texts()).toEqual(['一', '三', '二'])
    store.move(a!.id, 5)
    expect(texts()).toEqual(['三', '二', '一'])

    store.sort = 'oldest'
    expect(texts()).toEqual(['一', '二', '三'])
    store.sort = 'newest'
    expect(texts()).toEqual(['三', '二', '一'])
    store.items.find((item) => item.id === b!.id)!.duration = 9
    store.sort = 'longest'
    expect(texts()[0]).toBe('二')

    // 删除后自定义顺序中也去掉
    store.sort = 'custom'
    await store.remove([c!.id])
    expect(texts()).toEqual(['二', '一'])
    expect(JSON.parse(localStorage.getItem('favorites/order')!)).toEqual([b!.id, a!.id])
  })

  it('重新打开时从数据库读取', async () => {
    await favoriteAll(useFavoritesStore(), ['一', '二'])
    setActivePinia(createPinia())
    const store = useFavoritesStore()
    expect(store.items).toEqual([])
    await store.load()
    expect(store.sorted.map((item) => item.text)).toEqual(['二', '一'])
  })

  it('重听由桌宠播放，播放期间字幕显示这句话；桌宠正在说话时不能重听', async () => {
    const store = useFavoritesStore()
    const [favorite] = await favoriteAll(store, ['你好'])
    let replayDuringPlay: unknown
    mocks.audio.play.mockImplementation(async (audio) => {
      replayDuringPlay = { ...mocks.audio.replay }
      expect(store.playingId).toBe(favorite!.id)
      expect([...audio.uint8Array]).toEqual([0])
      expect(audio.mediaType).toBe('audio/mpeg')
    })

    await store.play(favorite!.id)
    expect(replayDuringPlay).toEqual({ text: '你好', speaker: 'ATRI' })
    expect(mocks.audio.replay).toBeNull()
    expect(store.playingId).toBeNull()

    mocks.audio.speechPending = true
    await expect(store.play(favorite!.id)).rejects.toThrow('桌宠正在说话')
    expect(mocks.audio.play).toHaveBeenCalledTimes(1)
  })
})
