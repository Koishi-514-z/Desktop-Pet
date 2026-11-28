import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearReplyAudio, getReplyAudio, MAX_CACHED_REPLIES, recordReplyAudio } from '@/utils/reply-audio'
import type { AudioDecoder } from '@/utils/favorites'
import { MERGE_SAMPLE_RATE, mergeSpeechAudio } from '@/utils/favorites'

// 每个用例使用全新的数据库，并重新加载模块（db.ts 会缓存打开的数据库）
async function load() {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.resetModules()
  return import('@/utils/favorites')
}

beforeEach(() => {
  vi.unstubAllGlobals()
  clearReplyAudio()
})

const clip = (bytes: number[], mediaType = 'audio/mpeg') => ({ uint8Array: new Uint8Array(bytes), mediaType })

describe('收藏的存储', () => {
  it('保存、读取与删除', async () => {
    const favorites = await load()
    const favorite = { id: favorites.createFavoriteId(), text: '早上好', personaName: 'ATRI', mediaType: 'audio/wav', data: new Blob(['x']), size: 1, duration: 1.5, createdAt: 1 }
    expect(favorite.id).toMatch(/^fav_\w{12}$/)
    await favorites.addFavorite(favorite)
    expect((await favorites.listFavorites()).map((item) => item.text)).toEqual(['早上好'])
    await favorites.deleteFavorites([favorite.id])
    expect(await favorites.listFavorites()).toEqual([])
  })
})

describe('把几句语音拼成一个文件', () => {
  it('只有一句时原样保存，保留原来的格式', async () => {
    const decode = vi.fn<AudioDecoder>()
    const merged = await mergeSpeechAudio([clip([1, 2, 3])], decode)
    expect(merged).toEqual({ data: new Uint8Array([1, 2, 3]), mediaType: 'audio/mpeg' })
    expect(decode).not.toHaveBeenCalled()
    await expect(mergeSpeechAudio([])).rejects.toThrow('没有语音')
  })

  it('有多句时解码后依次拼接，句间加上停顿，编码为 WAV', async () => {
    // 模拟解码：第一句 0.5 秒、第二句 0.25 秒，采样值分别为 0.5 与 -0.5
    const decode = vi.fn<AudioDecoder>(async (item, rate) =>
      new Float32Array(item.uint8Array[0] === 1 ? rate / 2 : rate / 4).fill(item.uint8Array[0] === 1 ? 0.5 : -0.5))
    const merged = await mergeSpeechAudio([clip([1]), clip([2], 'audio/ogg')], decode)
    expect(decode).toHaveBeenCalledWith(expect.anything(), MERGE_SAMPLE_RATE)
    expect(merged.mediaType).toBe('audio/wav')
    // 0.5 + 0.15（停顿）+ 0.25 秒
    expect(merged.duration).toBeCloseTo(0.9)

    const view = new DataView(merged.data.buffer, merged.data.byteOffset, merged.data.byteLength)
    expect(String.fromCharCode(...merged.data.slice(0, 4))).toBe('RIFF')
    expect(view.getUint32(24, true)).toBe(MERGE_SAMPLE_RATE)
    const samples = (merged.data.byteLength - 44) / 2
    expect(samples).toBe(Math.round(0.9 * MERGE_SAMPLE_RATE))
    const sample = (index: number) => view.getInt16(44 + index * 2, true) / 32768
    expect(sample(0)).toBeCloseTo(0.5, 2)
    expect(sample(MERGE_SAMPLE_RATE / 2 + 100)).toBe(0)
    expect(sample(samples - 1)).toBeCloseTo(-0.5, 2)
  })
})

describe('最近几条回复的语音', () => {
  it('按顺序记在所属的回复名下，只保留最近的几条', () => {
    const first = {}
    recordReplyAudio(first, clip([1]), { personaName: 'ATRI', voice: 'Fish Audio' })
    recordReplyAudio(first, clip([2]), { personaName: '别的', voice: '别的' })
    expect(getReplyAudio(first)).toEqual({ clips: [clip([1]), clip([2])], personaName: 'ATRI', voice: 'Fish Audio' })

    for (let i = 0; i < MAX_CACHED_REPLIES; i++) recordReplyAudio({}, clip([i]), { personaName: 'ATRI' })
    expect(getReplyAudio(first)).toBeUndefined()
  })
})
