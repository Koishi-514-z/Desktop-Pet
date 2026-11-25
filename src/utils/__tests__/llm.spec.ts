import type { Provider } from '@/stores/providers'
import { embedMany } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const httpFetch = vi.hoisted(() => vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>())
vi.mock('@/utils/http', () => ({ httpFetch }))

import { OPENAI_COMPATIBLE_EMBEDDING_BATCH, resolveEmbeddingModel } from '@/utils/llm'

function provider(patch: Partial<Provider> = {}): Provider {
  return {
    id: 'qwen', name: 'Qwen', category: 'llm', protocol: 'openai', baseUrl: 'https://cn-beijing.maas.qianwenaiapi.com/compatible-mode/v1',
    apiKey: 'sk-test', models: [], selectedModelId: 'qwen-plus', isValid: true,
    validator: async () => true, listModels: async () => [], ...patch,
  }
}

beforeEach(() => {
  httpFetch.mockReset()
})

describe('生成向量的模型', () => {
  it('OpenAI 兼容接口的请求从 Rust 端发出（不受跨域限制），每次最多 10 条', async () => {
    httpFetch.mockImplementation(async (_url, init) => {
      const { input } = JSON.parse(init?.body as string) as { input: string[] }
      return new Response(JSON.stringify({ data: input.map((_, index) => ({ object: 'embedding', index, embedding: [index, 1] })), usage: { prompt_tokens: 1 } }), {
        headers: { 'Content-Type': 'application/json' },
      })
    })
    const values = Array.from({ length: 12 }, (_, i) => `记忆 ${i}`)
    const { embeddings } = await embedMany({ model: resolveEmbeddingModel(provider(), 'text-embedding-v4'), values })

    expect(httpFetch).toHaveBeenCalledTimes(2)
    const [url, init] = httpFetch.mock.calls[0]!
    expect(String(url)).toBe('https://cn-beijing.maas.qianwenaiapi.com/compatible-mode/v1/embeddings')
    const batches = httpFetch.mock.calls.map(([, request]) => JSON.parse(request?.body as string))
    expect(batches.map((body) => body.input.length)).toEqual([OPENAI_COMPATIBLE_EMBEDDING_BATCH, 2])
    expect(batches[0].model).toBe('text-embedding-v4')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer sk-test')
    expect(embeddings).toHaveLength(12)
  })
})
