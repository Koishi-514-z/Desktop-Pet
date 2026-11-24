import type { LanguageModel } from 'ai'
import type { ExtractedMemory, MemoryDialogMessage } from '@/memory/extract'
import type { MergeCandidate, MergeDecision } from '@/memory/merge'
import type { MemoryUpdate, SimilarMemory } from '@/memory/types'
import { truncate } from '@/agent/utils'
import * as api from '@/memory/api'
import { extractMemories } from '@/memory/extract'
import { decideMerges } from '@/memory/merge'

// 去重时，每条新记忆参考的相似已有记忆数量
const SIMILAR_LIMIT = 5
// 交给记忆整理模块的最近消息数量
const DIALOG_SIZE = 8
// 划词内容在交给记忆整理模块的对话中保留的开头长度
const QUOTE_LENGTH = 160

/** 生成向量；未配置向量模型时返回 null */
export type Embedder = (texts: string[]) => Promise<{ embeddings: number[][], model: string } | null>

export interface WriteOptions {
  /** 用于合并记忆的模型 */
  model: LanguageModel
  embed?: Embedder
  /** 记录在记忆与变动记录中的来源，如 chat:会话 id */
  source: string
  /** 变动的批次，撤销时整批撤销 */
  batch?: string
  now?: Date
  abortSignal?: AbortSignal
}

export interface MemorizeOptions extends WriteOptions {
  /** 最近的对话，最后一条用户消息及其之后的回复为要整理的一轮 */
  dialog: MemoryDialogMessage[]
  assistantName: string
}

/** 聊天记录中的消息（结构子集） */
interface ChatLikeMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  hidden?: boolean
  quote?: string
  images?: unknown[]
}

/** 将聊天记录整理为交给记忆整理模块的对话：去掉系统提示词与隐藏消息，引用与图片只保留简短说明 */
export function toMemoryDialog(messages: ChatLikeMessage[]): MemoryDialogMessage[] {
  return messages
    .flatMap((message): MemoryDialogMessage[] => {
      if (message.role === 'system' || message.hidden) return []
      if (message.role === 'assistant') return message.content.trim() ? [{ role: 'assistant', content: message.content }] : []

      const notes = [
        message.quote ? `（引用了一段文字：${truncate(message.quote, QUOTE_LENGTH)}）` : '',
        message.images?.length ? `（附带 ${message.images.length} 张图片）` : '',
      ].filter(Boolean)
      const content = [message.content, ...notes].filter(Boolean).join(' ')
      return content ? [{ role: 'user', content }] : []
    })
    .slice(-DIALOG_SIZE)
}

/** 用于判断两条记忆是否完全相同：忽略开头的「用户」、空白、标点与大小写 */
export function normalizeContent(content: string): string {
  return content
    .toLowerCase()
    .replace(/^用户/, '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
}

/** 去掉同一批中内容相同的记忆 */
function dedupe(facts: ExtractedMemory[]): ExtractedMemory[] {
  const seen = new Set<string>()
  return facts.filter((fact) => {
    const key = normalizeContent(fact.content)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 生成向量，失败时返回 null（不影响写入，之后会自动补全） */
export async function safeEmbed(embed: Embedder | undefined, texts: string[]) {
  if (!embed || texts.length === 0) return null
  try {
    return await embed(texts)
  }
  catch (error) {
    console.warn('[memory] 生成向量失败，稍后补全：', error)
    return null
  }
}

/**
 * 把新记忆与已有记忆去重、合并后写入：
 * 内容完全相同的视为再次提到，记忆库中没有相似记忆的直接新增，其余交给 LLM 判断新增、重复还是合并。
 */
export async function writeFacts(facts: ExtractedMemory[], options: WriteOptions): Promise<MemoryUpdate[]> {
  const { model, embed, source, batch, now = new Date(), abortSignal } = options
  facts = dedupe(facts)
  if (facts.length === 0) return []
  const change = { source, batch }

  // 找出每条新记忆相似的已有记忆
  const factEmbeddings = await safeEmbed(embed, facts.map((fact) => fact.content))
  const similar: SimilarMemory[][] = []
  for (const [index, fact] of facts.entries()) {
    similar.push(await api.findSimilarMemories({
      content: fact.content,
      embedding: factEmbeddings?.embeddings[index],
      embeddingModel: factEmbeddings?.model,
      limit: SIMILAR_LIMIT,
    }))
  }

  // 去重、合并。内容完全相同的直接视为重复，没有相似记忆的直接新增，其余交给 LLM 判断
  const decisions: MergeDecision[] = facts.map(() => ({ action: 'add' }))
  const pending: number[] = []
  facts.forEach((fact, index) => {
    const key = normalizeContent(fact.content)
    const duplicate = similar[index]!.find((memory) => normalizeContent(memory.content) === key)
    if (duplicate) decisions[index] = { action: 'skip', target: duplicate.id }
    else if (similar[index]!.length > 0) pending.push(index)
  })
  if (pending.length > 0) {
    const candidates: MergeCandidate[] = pending.map((index) => ({ fact: facts[index]!, similar: similar[index]! }))
    const decided = await decideMerges({ model, candidates, now, abortSignal })
    pending.forEach((factIndex, position) => {
      decisions[factIndex] = decided[position] ?? { action: 'add' }
    })
  }

  // 合并后的内容需要重新生成向量
  const merged = decisions.flatMap((decision) => (decision.action === 'update' ? [decision.content] : []))
  const mergedEmbeddings = await safeEmbed(embed, merged)

  // 执行写入
  const known = new Map(similar.flat().map((memory) => [memory.id, memory]))
  const archived = new Set<number>()
  const updates: MemoryUpdate[] = []
  let mergedIndex = 0

  for (const [index, fact] of facts.entries()) {
    let decision = decisions[index]!
    // 目标已在本轮被合并到其他记忆中：重复的直接跳过（信息已在合并后的记忆里），需要更新的改为新增
    if (decision.action === 'skip' && decision.target !== undefined && archived.has(decision.target)) continue
    if (decision.action === 'update' && archived.has(decision.target)) {
      mergedIndex++
      decision = { action: 'add' }
    }

    if (decision.action === 'add') {
      const memory = await api.addMemory({
        category: fact.category,
        content: fact.content,
        importance: fact.importance,
        occurredAt: fact.occurredAt,
        source,
        embedding: factEmbeddings?.embeddings[index],
        embeddingModel: factEmbeddings?.model,
      }, change)
      updates.push({ action: 'add', memoryId: memory.id, category: memory.category, content: memory.content })
    }
    else if (decision.action === 'skip') {
      if (decision.target === undefined) continue
      const memory = await api.reinforceMemory(decision.target, fact.importance, change)
      updates.push({ action: 'reinforce', memoryId: memory.id, category: memory.category, content: memory.content })
    }
    else {
      const embedding = mergedEmbeddings?.embeddings[mergedIndex]
      mergedIndex++
      const previous = known.get(decision.target)?.content
      const memory = await api.updateMemory(decision.target, {
        content: decision.content,
        category: decision.category,
        importance: decision.importance,
        occurredAt: fact.occurredAt,
        embedding,
        embeddingModel: embedding ? mergedEmbeddings?.model : undefined,
      }, change)

      const remove = decision.remove.filter((id) => !archived.has(id))
      const count = remove.length > 0 ? await api.archiveMemories(remove, change) : 0
      remove.forEach((id) => archived.add(id))
      updates.push({ action: 'update', memoryId: memory.id, category: memory.category, content: memory.content, previous, merged: count })
    }
  }
  return updates
}

/**
 * 记忆写入：从最新一轮对话中提取值得记住的信息，与已有记忆去重、合并后写入。
 * 返回本轮记忆的变动，没有值得记住的信息时返回空数组。
 */
export async function memorizeTurn(options: MemorizeOptions): Promise<MemoryUpdate[]> {
  const { model, dialog, assistantName, now = new Date(), abortSignal } = options
  const facts = await extractMemories({ model, dialog, assistantName, now, abortSignal })
  return writeFacts(facts, { ...options, now })
}
