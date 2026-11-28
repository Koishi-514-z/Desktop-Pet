import type { EmbeddingModelMiddleware, LanguageModelMiddleware } from 'ai'
import type { UsageSource } from '@/stores/usage'
import { recordUsage } from '@/stores/usage'

/**
 * 记录模型调用的用量（见 stores/usage.ts）：以 AI SDK 中间件的形式包在模型外面（见 utils/llm.ts），
 * 所有用到这个模型的地方（对话、意图识别、工具执行、整理记忆、主动交互、翻译等）都会自动记录，不需要逐个修改。
 * 流式输出在收到结束标记时记录；被打断、出错的请求拿不到用量，不会记录
 */

/** 用量中的一项：AI SDK 的 v3 格式是 { total, ... } 对象，旧的格式是数字 */
function tokenCount(value: unknown, field = 'total'): number {
  if (typeof value === 'number') return value
  if (value && typeof value === 'object') {
    const count = (value as Record<string, unknown>)[field]
    return typeof count === 'number' ? count : 0
  }
  return 0
}

export function recordLanguageUsage(source: Omit<UsageSource, 'kind'>, usage: unknown) {
  const { inputTokens, outputTokens } = (usage ?? {}) as { inputTokens?: unknown, outputTokens?: unknown }
  recordUsage({ ...source, kind: 'llm' }, {
    inputTokens: tokenCount(inputTokens),
    cachedInputTokens: tokenCount(inputTokens, 'cacheRead'),
    outputTokens: tokenCount(outputTokens),
  })
}

export function languageUsageMiddleware(source: Omit<UsageSource, 'kind'>): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate()
      recordLanguageUsage(source, result.usage)
      return result
    },
    wrapStream: async ({ doStream }) => {
      const { stream, ...rest } = await doStream()
      return {
        ...rest,
        stream: stream.pipeThrough(new TransformStream({
          transform(part, controller) {
            if (part.type === 'finish') recordLanguageUsage(source, part.usage)
            controller.enqueue(part)
          },
        })),
      }
    },
  }
}

export function embeddingUsageMiddleware(source: Omit<UsageSource, 'kind'>): EmbeddingModelMiddleware {
  return {
    specificationVersion: 'v3',
    wrapEmbed: async ({ doEmbed }) => {
      const result = await doEmbed()
      recordUsage({ ...source, kind: 'embedding' }, { inputTokens: result.usage?.tokens ?? 0 })
      return result
    },
  }
}

/** WAV 录音的时长（秒）；不是 WAV 时返回 undefined */
export function wavDurationSeconds(audio: Uint8Array): number | undefined {
  if (audio.length < 44 || String.fromCharCode(...audio.subarray(0, 4)) !== 'RIFF') return undefined
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
  const byteRate = view.getUint32(28, true)
  return byteRate > 0 ? (audio.length - 44) / byteRate : undefined
}
