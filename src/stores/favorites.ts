import type { GeneratedAudioFile } from 'ai'
import type { ChatMessage } from '@/stores/chat'
import type { Favorite } from '@/utils/favorites'
import type { AudioClip } from '@/utils/reply-audio'
import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef, toRaw } from 'vue'
import { useAudioStore } from '@/stores/audio'
import { useChatStore } from '@/stores/chat'
import { useLanguageStore } from '@/stores/language'
import { usePersonaStore } from '@/stores/persona'
import { useProvidersStore } from '@/stores/providers'
import { useSpeechStore } from '@/stores/speech'
import { readAudioDuration } from '@/utils/audios'
import { addFavorite, createFavoriteId, deleteFavorites, listFavorites, mergeSpeechAudio } from '@/utils/favorites'
import { getReplyAudio } from '@/utils/reply-audio'

/** 收藏列表的排列方式：自定义（可以拖动调整）、收藏时间、时长 */
export type FavoriteSort = 'custom' | 'newest' | 'oldest' | 'longest'

export const FAVORITE_SORTS: { id: FavoriteSort, label: string }[] = [
  { id: 'custom', label: '自定义' },
  { id: 'newest', label: '最新收藏' },
  { id: 'oldest', label: '最早收藏' },
  { id: 'longest', label: '时长' },
]

/**
 * 收藏的桌宠语音：在字幕上收藏桌宠的回复，在设置的「收藏」页重听、排序、删除。
 * 收藏时优先使用这条回复刚刚播放过的语音（见 utils/reply-audio.ts），不在缓存中时用当前的语音服务重新合成。
 * 重听由桌宠来播放：模型会对口型，字幕显示这句话
 */
export const useFavoritesStore = defineStore('favorites', () => {
  const audioStore = useAudioStore()
  const chatStore = useChatStore()

  const items = ref<Favorite[]>([])
  const loaded = ref(false)
  let loading: Promise<void> | null = null
  // 自定义顺序：收藏的 id，排在前面的显示在前面；新的收藏放在最前面
  const order = useLocalStorage<string[]>('favorites/order', [])
  const sort = useLocalStorage<FavoriteSort>('favorites/sort', 'custom')

  // 正在收藏的回复（原始的消息对象）
  const saving = shallowRef(new Set<object>())
  // 正在重听的收藏
  const playingId = ref<string | null>(null)

  const ids = computed(() => new Set(items.value.map((item) => item.id)))

  function load(): Promise<void> {
    loading ??= listFavorites()
      .then((list) => {
        items.value = list
        loaded.value = true
      })
      .catch((error) => {
        loading = null
        throw error
      })
    return loading
  }

  /** 按当前的排列方式排好的收藏 */
  const sorted = computed(() => {
    const list = [...items.value]
    switch (sort.value) {
      case 'newest': return list.sort((a, b) => b.createdAt - a.createdAt)
      case 'oldest': return list.sort((a, b) => a.createdAt - b.createdAt)
      case 'longest': return list.sort((a, b) => b.duration - a.duration || b.createdAt - a.createdAt)
      default: {
        // 自定义顺序；不在其中的（如顺序数据丢失）按收藏时间排在最前面
        const position = new Map(order.value.map((id, index) => [id, index]))
        return list.sort((a, b) => (position.get(a.id) ?? -1) - (position.get(b.id) ?? -1) || b.createdAt - a.createdAt)
      }
    }
  })

  function isFavorited(message: ChatMessage): boolean {
    return !!message.favoriteId && ids.value.has(message.favoriteId)
  }

  function isSaving(message: ChatMessage): boolean {
    return saving.value.has(toRaw(message))
  }

  /** 这条回复的语音不在缓存中时，用当前的语音服务重新合成整段话 */
  async function synthesize(message: ChatMessage): Promise<AudioClip> {
    const speechStore = useSpeechStore()
    if (!useProvidersStore().getCurrentTTSProvider()) {
      throw new Error('这条回复的语音已经不在了，需要重新合成，但还没有配置语音合成服务（设置 → Provider）')
    }
    const speakable = speechStore.toSpeakableText(message.rawContent ?? message.content)
    if (!/[\p{L}\p{N}]/u.test(speakable)) throw new Error('这条回复没有要念的内容')
    const text = await useLanguageStore().toSpeechText(speakable)
    const audio = await speechStore.speak(text)
    if (!audio) throw new Error('重新合成语音失败，请检查语音合成服务的设置')
    return { uint8Array: audio.uint8Array, mediaType: audio.mediaType }
  }

  /** 收藏一条桌宠的回复：把它的语音拼成一个音频文件，连同文字保存下来 */
  async function favoriteMessage(message: ChatMessage): Promise<Favorite> {
    const raw = toRaw(message)
    if (saving.value.has(raw)) throw new Error('正在收藏这条回复')
    saving.value = new Set([...saving.value, raw])
    try {
      await load()
      const existing = message.favoriteId && items.value.find((item) => item.id === message.favoriteId)
      if (existing) return existing
      const cached = getReplyAudio(raw)
      const clips = cached?.clips.length ? cached.clips : [await synthesize(message)]
      const merged = await mergeSpeechAudio(clips)
      const data = new Blob([merged.data as BlobPart], { type: merged.mediaType })
      const voice = cached ? cached.voice : useProvidersStore().getCurrentTTSProvider()?.name
      const favorite: Favorite = {
        id: createFavoriteId(),
        text: message.content.trim(),
        personaName: cached?.personaName ?? usePersonaStore().currentPersona?.name ?? '桌宠',
        ...(voice ? { voice } : {}),
        mediaType: merged.mediaType,
        data,
        size: data.size,
        duration: merged.duration ?? await readAudioDuration(data),
        createdAt: Date.now(),
      }
      await addFavorite(favorite)
      items.value = [...items.value, favorite]
      order.value = [favorite.id, ...order.value.filter((id) => ids.value.has(id))]
      message.favoriteId = favorite.id
      return favorite
    }
    finally {
      const next = new Set(saving.value)
      next.delete(raw)
      saving.value = next
    }
  }

  /** 删除收藏 */
  async function remove(targets: string[]): Promise<void> {
    if (targets.length === 0) return
    if (playingId.value && targets.includes(playingId.value)) stop()
    await deleteFavorites(targets)
    items.value = items.value.filter((item) => !targets.includes(item.id))
    order.value = order.value.filter((id) => !targets.includes(id))
  }

  /** 在字幕上取消收藏 */
  async function unfavoriteMessage(message: ChatMessage): Promise<void> {
    if (!message.favoriteId) return
    await remove([message.favoriteId])
    delete message.favoriteId
  }

  /** 调整自定义顺序：把一条收藏移到第 index 个位置（按当前自定义顺序排好的列表中的位置） */
  function move(id: string, index: number): void {
    const list = sort.value === 'custom' ? sorted.value.map((item) => item.id) : [...order.value]
    const from = list.indexOf(id)
    if (from < 0) return
    list.splice(from, 1)
    list.splice(Math.max(0, Math.min(index, list.length)), 0, id)
    order.value = list
  }

  /** 桌宠是否正在回复（正在生成回复，或者语音还没播完）；这时不能重听，免得和它说的话混在一起 */
  const petBusy = computed(() => chatStore.isStreaming || audioStore.speechPending)

  /** 重听一条收藏：由桌宠播放，模型会对口型，字幕显示这句话 */
  async function play(id: string): Promise<void> {
    const favorite = items.value.find((item) => item.id === id)
    if (!favorite) return
    if (petBusy.value) throw new Error('桌宠正在说话，等它说完再听')
    const bytes = new Uint8Array(await favorite.data.arrayBuffer())
    playingId.value = id
    audioStore.replay = { text: favorite.text, speaker: favorite.personaName }
    try {
      await audioStore.play({ uint8Array: bytes, mediaType: favorite.mediaType } as GeneratedAudioFile)
    }
    finally {
      // 播放另一条收藏时，这一条的结束不能清掉那一条的状态
      if (playingId.value === id) {
        playingId.value = null
        audioStore.replay = null
      }
    }
  }

  function stop(): void {
    if (!playingId.value) return
    audioStore.stop()
  }

  return {
    items,
    loaded,
    sort,
    sorted,
    playingId,
    petBusy,
    load,
    isFavorited,
    isSaving,
    favoriteMessage,
    unfavoriteMessage,
    remove,
    move,
    play,
    stop,
  }
})
