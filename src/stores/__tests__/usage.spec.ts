import { MockEmbeddingModelV3, MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import { embed, generateText, streamText, wrapEmbeddingModel, wrapLanguageModel } from 'ai'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { costOf, emptyTotals, RETENTION_DAYS, useUsageStore } from '@/stores/usage'
import { embeddingUsageMiddleware, languageUsageMiddleware, wavDurationSeconds } from '@/utils/usage-tracking'
import { encodeWav } from '@/utils/voice-activity'

type StreamPart = Awaited<ReturnType<MockLanguageModelV3['doStream']>>['stream'] extends ReadableStream<infer T> ? T : never

const source = { providerId: 'p1', providerName: '硅基流动', modelId: 'qwen' }
const usage = {
  inputTokens: { total: 1200, noCache: 200, cacheRead: 1000, cacheWrite: 0 },
  outputTokens: { total: 300, text: 250, reasoning: 50 },
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

describe('用量记录', () => {
  it('按天、Provider、模型、种类汇总；新的一天开始时清掉太早的记录', () => {
    const store = useUsageStore()
    const day1 = new Date(2026, 10, 27, 10)
    store.record({ ...source, kind: 'llm' }, { inputTokens: 100, outputTokens: 20 }, day1)
    store.record({ ...source, kind: 'llm' }, { inputTokens: 50, cachedInputTokens: 30, outputTokens: 5 }, day1)
    store.record({ ...source, kind: 'tts' }, { characters: 12 }, day1)
    expect(store.records).toHaveLength(2)
    expect(store.records[0]).toMatchObject({ day: '2026-11-27', kind: 'llm', requests: 2, inputTokens: 150, cachedInputTokens: 30, outputTokens: 25 })

    const later = new Date(day1.getTime() + (RETENTION_DAYS + 1) * 86_400_000)
    store.record({ ...source, kind: 'llm' }, { inputTokens: 1 }, later)
    expect(store.records).toHaveLength(1)
  })

  it('按填写的价格计算费用：缓存命中的输入可以单独定价，没有填写需要的价格时为 null', () => {
    const totals = { ...emptyTotals(), inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 200_000, characters: 500_000, seconds: 1800 }
    expect(costOf('llm', totals, undefined)).toBeNull()
    expect(costOf('llm', totals, { currency: 'CNY' })).toBeNull()
    // 60 万 × 2 + 40 万 × 0.5 + 20 万 × 8（每百万）
    expect(costOf('llm', totals, { currency: 'CNY', input: 2, cachedInput: 0.5, output: 8 })).toBeCloseTo(1.2 + 0.2 + 1.6)
    // 缓存命中不单独定价时按输入价格
    expect(costOf('llm', totals, { currency: 'USD', input: 2, output: 8 })).toBeCloseTo(2 + 1.6)
    expect(costOf('embedding', totals, { currency: 'CNY', input: 0.5 })).toBeCloseTo(0.5)
    expect(costOf('tts', totals, { currency: 'USD', characters: 15 })).toBeCloseTo(7.5)
    expect(costOf('asr', totals, { currency: 'USD', hour: 0.36 })).toBeCloseTo(0.18)
    expect(costOf('asr', totals, { currency: 'USD', input: 1 })).toBeNull()
  })

  it('价格按 Provider + 模型保存，可以删除；清空用量时价格保留', () => {
    const store = useUsageStore()
    store.setPrice('p1', 'qwen', { currency: 'CNY', input: 2 })
    expect(store.getPrice('p1', 'qwen')).toEqual({ currency: 'CNY', input: 2 })
    expect(store.getPrice('p2', 'qwen')).toBeUndefined()
    store.record({ ...source, kind: 'llm' }, { inputTokens: 1 })
    store.clearRecords()
    expect(store.records).toEqual([])
    expect(store.getPrice('p1', 'qwen')).toBeDefined()
    store.setPrice('p1', 'qwen', null)
    expect(store.prices).toEqual({})
  })
})

describe('调用模型时自动记录', () => {
  function tracked(model: MockLanguageModelV3) {
    return wrapLanguageModel({ model, middleware: languageUsageMiddleware(source) })
  }

  it('生成：记录输入、命中缓存的输入与输出 token', async () => {
    const model = tracked(new MockLanguageModelV3({
      doGenerate: async () => ({ content: [{ type: 'text', text: '好' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }),
    }))
    await generateText({ model, prompt: '你好' })
    expect(useUsageStore().records[0]).toMatchObject({ ...source, kind: 'llm', requests: 1, inputTokens: 1200, cachedInputTokens: 1000, outputTokens: 300 })
  })

  it('流式输出：在结束时记录；没有结束（被打断）时不记录', async () => {
    const parts = (finish: boolean): StreamPart[] => [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: '你好' },
      { type: 'text-end', id: 't' },
      ...(finish ? [{ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage } as StreamPart] : []),
    ]
    const model = tracked(new MockLanguageModelV3({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: parts(true) }) }),
    }))
    const result = streamText({ model, prompt: '你好' })
    expect(await result.text).toBe('你好')
    expect(useUsageStore().records[0]).toMatchObject({ requests: 1, inputTokens: 1200, outputTokens: 300 })

    const unfinished = tracked(new MockLanguageModelV3({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: parts(false) }) }),
    }))
    await streamText({ model: unfinished, prompt: '你好' }).consumeStream()
    expect(useUsageStore().records[0]!.requests).toBe(1)
  })

  it('向量化：记录输入 token', async () => {
    const model = wrapEmbeddingModel({
      model: new MockEmbeddingModelV3({ doEmbed: async () => ({ embeddings: [[0.1, 0.2]], usage: { tokens: 42 }, warnings: [] }) }),
      middleware: embeddingUsageMiddleware(source),
    })
    await embed({ model, value: '你好' })
    expect(useUsageStore().records[0]).toMatchObject({ kind: 'embedding', requests: 1, inputTokens: 42 })
  })

  it('录音的时长：WAV 按数据长度计算，不是 WAV 时为 undefined', () => {
    expect(wavDurationSeconds(encodeWav(new Float32Array(16_000 * 3)))).toBeCloseTo(3)
    expect(wavDurationSeconds(new Uint8Array([1, 2, 3]))).toBeUndefined()
  })
})
