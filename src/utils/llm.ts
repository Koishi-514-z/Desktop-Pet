import type { EmbeddingModel, LanguageModel } from 'ai'
import type { Provider } from '@/stores/providers'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { wrapEmbeddingModel } from 'ai'
import { httpFetch } from '@/utils/http'

// 根据 provider 配置的协议类型，创建对应的 AI SDK 语言模型实例；modelId 默认为 provider 当前选中的模型
export function resolveLanguageModel(provider: Provider, modelId = provider.selectedModelId): LanguageModel {
  const { apiKey, baseUrl, protocol } = provider

  switch (protocol) {
    case 'openai':
      // 使用 chat() 对应 Chat Completions 协议，兼容大多数第三方 OpenAI 兼容平台
      return createOpenAI({ apiKey, baseURL: baseUrl }).chat(modelId)
    case 'anthropic':
      return createAnthropic({ apiKey, baseURL: baseUrl })(modelId)
    case 'google':
      return createGoogleGenerativeAI({ apiKey, baseURL: baseUrl })(modelId)
    default:
      throw new Error(`协议 ${protocol} 暂不支持对话`)
  }
}

// OpenAI 兼容接口一次请求最多生成多少条向量：阿里云百炼的 text-embedding-v3 / v4 一次最多 10 条，
// 超过时 embedMany 会自动分成几次请求
export const OPENAI_COMPATIBLE_EMBEDDING_BATCH = 10

// 创建生成向量（embedding）的模型，用于长期记忆的语义检索
export function resolveEmbeddingModel(provider: Provider, modelId: string): EmbeddingModel {
  const { apiKey, baseUrl, protocol } = provider

  switch (protocol) {
    case 'openai':
      // OpenAI 兼容的 /embeddings 接口，硅基流动、阿里云百炼等平台也可以使用。
      // 请求从 Rust 端发出：有的平台不允许浏览器跨域访问 /embeddings（如阿里云百炼，对话接口却可以）
      return wrapEmbeddingModel({
        model: createOpenAI({ apiKey, baseURL: baseUrl, fetch: httpFetch }).embedding(modelId),
        middleware: { specificationVersion: 'v3', overrideMaxEmbeddingsPerCall: () => OPENAI_COMPATIBLE_EMBEDDING_BATCH },
      })
    case 'google':
      return createGoogleGenerativeAI({ apiKey, baseURL: baseUrl }).embedding(modelId)
    default:
      throw new Error(`${provider.name} 使用的 ${protocol} 协议不支持生成向量`)
  }
}

// 支持生成向量的协议
export function supportsEmbedding(provider: Provider): boolean {
  return provider.protocol === 'openai' || provider.protocol === 'google'
}
