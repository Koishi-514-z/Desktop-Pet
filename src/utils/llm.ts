import type { EmbeddingModel, LanguageModel } from 'ai'
import type { Provider } from '@/stores/providers'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'

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

// 创建生成向量（embedding）的模型，用于长期记忆的语义检索
export function resolveEmbeddingModel(provider: Provider, modelId: string): EmbeddingModel {
  const { apiKey, baseUrl, protocol } = provider

  switch (protocol) {
    case 'openai':
      // OpenAI 兼容的 /embeddings 接口，硅基流动、阿里云百炼等平台也可以使用
      return createOpenAI({ apiKey, baseURL: baseUrl }).embedding(modelId)
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
