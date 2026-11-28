import { getActivePinia, defineStore } from 'pinia'
import { useLocalStorage } from '@vueuse/core'

/**
 * 每个 Provider（及其模型）的用量与费用统计。
 *
 * - 用量：调用模型时自动记录（见 utils/usage-tracking.ts 与语音合成、语音识别的 store），按天、Provider、模型汇总保存在本地；
 *   对话按 token（输入、命中缓存的输入、输出），向量化按输入 token，语音合成按字符数，语音识别按音频时长计。
 * - 费用：价格由用户按「Provider + 模型」填写（各家服务商、中转平台的价格不同，也经常调整），
 *   统计时按当前填写的价格计算，因此先用了、后填价格也能算出之前的费用。只是估算，以服务商的账单为准。
 */

export type UsageKind = 'llm' | 'embedding' | 'tts' | 'asr'

export const USAGE_KIND_LABELS: Record<UsageKind, string> = {
  llm: '对话',
  embedding: '向量化',
  tts: '语音合成',
  asr: '语音识别',
}

/** 用量的来源：哪个 Provider 的哪个模型 */
export interface UsageSource {
  providerId: string
  /** 记录时的名称：Provider 之后被删除时仍然能显示 */
  providerName: string
  modelId: string
  kind: UsageKind
}

export interface UsageTotals {
  requests: number
  /** 输入 token（包含命中缓存的部分）；向量化的 token 也记在这里 */
  inputTokens: number
  /** 其中命中缓存的输入 token */
  cachedInputTokens: number
  /** 输出 token（包含推理模型的思考部分） */
  outputTokens: number
  /** 语音合成的字符数 */
  characters: number
  /** 语音识别的音频时长（秒） */
  seconds: number
}

/** 某一天、某个 Provider 的某个模型的用量 */
export interface UsageRecord extends UsageSource, UsageTotals {
  /** 本地日期，YYYY-MM-DD */
  day: string
}

export type UsageDelta = Partial<Omit<UsageTotals, 'requests'>>

export type Currency = 'CNY' | 'USD'

export const CURRENCY_SYMBOLS: Record<Currency, string> = { CNY: '¥', USD: '$' }

/** 一个模型的价格，按用量的种类填写对应的项 */
export interface ModelPrice {
  currency: Currency
  /** 每百万输入 token（对话、向量化） */
  input?: number
  /** 每百万命中缓存的输入 token；不填时按 input 计 */
  cachedInput?: number
  /** 每百万输出 token */
  output?: number
  /** 每百万字符（语音合成） */
  characters?: number
  /** 每小时音频（语音识别） */
  hour?: number
}

/** 用量记录保存多少天 */
export const RETENTION_DAYS = 400

const pad = (value: number) => String(value).padStart(2, '0')

/** 本地日期，如 2026-11-28 */
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function priceKey(providerId: string, modelId: string): string {
  return `${providerId}|${modelId}`
}

export function emptyTotals(): UsageTotals {
  return { requests: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, characters: 0, seconds: 0 }
}

export function addTotals(target: UsageTotals, source: UsageTotals): UsageTotals {
  target.requests += source.requests
  target.inputTokens += source.inputTokens
  target.cachedInputTokens += source.cachedInputTokens
  target.outputTokens += source.outputTokens
  target.characters += source.characters
  target.seconds += source.seconds
  return target
}

/**
 * 按价格算出费用；没有填写这种用量需要的价格时返回 null（界面上显示「未设置价格」）
 */
export function costOf(kind: UsageKind, totals: UsageTotals, price: ModelPrice | undefined): number | null {
  if (!price) return null
  switch (kind) {
    case 'llm': {
      if (price.input === undefined && price.output === undefined) return null
      const input = price.input ?? 0
      const cached = price.cachedInput ?? input
      const uncached = Math.max(0, totals.inputTokens - totals.cachedInputTokens)
      return (uncached * input + totals.cachedInputTokens * cached + totals.outputTokens * (price.output ?? 0)) / 1e6
    }
    case 'embedding':
      return price.input === undefined ? null : totals.inputTokens * price.input / 1e6
    case 'tts':
      return price.characters === undefined ? null : totals.characters * price.characters / 1e6
    case 'asr':
      return price.hour === undefined ? null : totals.seconds / 3600 * price.hour
  }
}

export const useUsageStore = defineStore('usage', () => {
  const records = useLocalStorage<UsageRecord[]>('usage/records', [])
  const prices = useLocalStorage<Record<string, ModelPrice>>('usage/prices', {})

  /** 记一次请求的用量 */
  function record(source: UsageSource, delta: UsageDelta, now = new Date()) {
    const day = dayKey(now)
    let entry = records.value.find((item) =>
      item.day === day && item.providerId === source.providerId && item.modelId === source.modelId && item.kind === source.kind)
    if (!entry) {
      entry = { day, ...source, ...emptyTotals() }
      // 新的一天第一次记录时，顺便清掉太早的记录
      const oldest = dayKey(new Date(now.getTime() - RETENTION_DAYS * 86_400_000))
      records.value = [...records.value.filter((item) => item.day >= oldest), entry]
      entry = records.value.at(-1)!
    }
    entry.providerName = source.providerName
    entry.requests += 1
    entry.inputTokens += delta.inputTokens ?? 0
    entry.cachedInputTokens += delta.cachedInputTokens ?? 0
    entry.outputTokens += delta.outputTokens ?? 0
    entry.characters += delta.characters ?? 0
    entry.seconds += delta.seconds ?? 0
  }

  function getPrice(providerId: string, modelId: string): ModelPrice | undefined {
    return prices.value[priceKey(providerId, modelId)]
  }

  /** 设置一个模型的价格；为 null 时删除 */
  function setPrice(providerId: string, modelId: string, price: ModelPrice | null) {
    const key = priceKey(providerId, modelId)
    const { [key]: _, ...rest } = prices.value
    prices.value = price ? { ...rest, [key]: price } : rest
  }

  /** 清空用量记录（价格保留） */
  function clearRecords() {
    records.value = []
  }

  return { records, prices, record, getPrice, setPrice, clearRecords }
})

/**
 * 记一次请求的用量。在模型调用的回调中使用，不能影响调用本身：
 * 没有可用的 Pinia（如单元测试中直接调用模型）或者记录出错时忽略
 */
export function recordUsage(source: UsageSource, delta: UsageDelta) {
  if (!getActivePinia()) return
  try {
    useUsageStore().record(source, delta)
  }
  catch (error) {
    console.warn('[usage] 记录用量失败：', error)
  }
}
