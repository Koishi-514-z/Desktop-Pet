import type { LanguageModel } from 'ai'
import type { Embedder } from '@/memory/writer'
import type { Memory, MemoryCategory } from '@/memory/types'
import { generateText } from 'ai'
import { z } from 'zod'
import { formatDate, formatDateTime, parseJsonObject } from '@/agent/utils'
import * as api from '@/memory/api'
import { categoryLabel } from '@/memory/types'
import { safeEmbed } from '@/memory/writer'

// 整理后单条记忆的最大长度
const MAX_CONTENT_LENGTH = 150
// 整理产生的变动来源
export const CONSOLIDATE_SOURCE = 'consolidate'

/** 对一组记忆的整理操作 */
export type ConsolidationOperation =
  /** 合并为一条：更新其中最重要的一条，归档其余的 */
  | { type: 'merge', ids: number[], content: string, category: MemoryCategory, importance: number }
  /** 改写表述 */
  | { type: 'update', id: number, content: string, category: MemoryCategory, importance: number }
  /** 归档失效的记忆 */
  | { type: 'archive', ids: number[] }

export interface ConsolidationResult {
  /** 交给 LLM 整理的组数 */
  groups: number
  /** 合并的次数 */
  merged: number
  /** 改写的记忆数量 */
  updated: number
  /** 归档的记忆数量（含合并时归档的） */
  archived: number
  /** 本次整理的批次，可以整批撤销 */
  batch: string
}

const CATEGORIES = ['profile', 'preference', 'episodic', 'plan', 'relationship'] as const

const operationSchema = z.object({
  type: z.enum(['merge', 'update', 'archive']),
  id: z.coerce.number().int().nullish(),
  ids: z.array(z.coerce.number().int()).nullish(),
  content: z.string().nullish(),
  category: z.enum(CATEGORIES).nullish(),
  importance: z.coerce.number().nullish(),
})

function clampImportance(value: number | null | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value!, 0), 1) : fallback
}

/** 合并时保留的记忆：最重要的一条，同样重要时保留最早的 */
export function mergeTarget(memories: Memory[]): Memory {
  return [...memories].sort((a, b) => b.importance - a.importance || a.createdAt - b.createdAt)[0]!
}

/**
 * 解析 LLM 给出的整理操作并逐条校验：只能引用这一组中的记忆，每条记忆最多参与一个操作，
 * 合并至少需要两条记忆，合并与改写必须给出内容。不合法的操作直接丢弃
 */
export function parseConsolidation(text: string, memories: Memory[]): ConsolidationOperation[] {
  const known = new Map(memories.map((memory) => [memory.id, memory]))
  const used = new Set<number>()
  const take = (ids: number[]) => [...new Set(ids)].filter((id) => known.has(id) && !used.has(id))

  const data = parseJsonObject(text)
  const items = Array.isArray(data?.operations) ? data.operations : []
  const operations: ConsolidationOperation[] = []

  for (const item of items) {
    const result = operationSchema.safeParse(item)
    if (!result.success) continue
    const { type, id, ids, category, importance } = result.data
    const content = result.data.content?.trim().slice(0, MAX_CONTENT_LENGTH) ?? ''

    if (type === 'merge') {
      const merged = take(ids ?? [])
      if (merged.length < 2 || !content) continue
      const members = merged.map((memberId) => known.get(memberId)!)
      const target = mergeTarget(members)
      operations.push({
        type: 'merge',
        ids: merged,
        content,
        category: category ?? target.category,
        importance: clampImportance(importance, Math.max(...members.map((member) => member.importance))),
      })
      merged.forEach((memberId) => used.add(memberId))
    }
    else if (type === 'update') {
      const [target] = take(id == null ? [] : [id])
      const memory = target === undefined ? undefined : known.get(target)
      if (!memory || !content || content === memory.content) continue
      operations.push({
        type: 'update',
        id: memory.id,
        content,
        category: category ?? memory.category,
        importance: clampImportance(importance, memory.importance),
      })
      used.add(memory.id)
    }
    else {
      const archived = take(ids ?? (id == null ? [] : [id]))
      if (archived.length === 0) continue
      operations.push({ type: 'archive', ids: archived })
      archived.forEach((memberId) => used.add(memberId))
    }
  }
  return operations
}

export function buildConsolidationSystemPrompt(now: Date): string {
  return `你是桌宠的记忆整理模块，负责定期整理记忆库，让记忆更精炼、准确、不重复。你的输出只给程序读取。

# 当前时间
${formatDateTime(now)}

# 整理方式
下面是同一类别的一组记忆。请找出需要整理的记忆，给出以下操作：
- merge：多条记忆重复、高度相似，或描述的是同一件事 → 合并为一条完整的记忆。ids 列出参与合并的全部记忆 id，content 为合并后的内容。
  - 多条情景记忆反映出用户稳定的习惯或偏好时，也可以归纳为一条偏好习惯（category 设为 preference）。
  - 互相矛盾的记忆以较新的为准，合并为一条（必要时注明以前的情况）。
- update：表述不清楚、指代不明或包含多余细节的记忆 → 改写得清楚、简洁，不改变含义。
- archive：已经失效、不再有参考价值的记忆，如早已过去且没有长期意义的计划、被后来的记忆否定的说法。

要求：
- 合并或改写后的内容以「用户」开头，不超过 80 字，不要编造记忆中没有的信息。
- 不同的具体事件（如两次不同的考试）不要合并，除非是在归纳习惯。
- 每条记忆最多出现在一个操作中，只能使用下面列出的 id。
- 大多数记忆都不需要整理，不需要整理的不要列出；拿不准时不要处理。

# 输出格式
只输出一个 JSON 对象，例如：
{"operations": [{"type": "merge", "ids": [3, 7], "content": "用户喜欢猫，养了一只叫团子的橘猫", "importance": 0.6}, {"type": "update", "id": 5, "content": "用户在上海的一家游戏公司工作"}, {"type": "archive", "ids": [9]}]}
没有需要整理的记忆时输出：{"operations": []}`
}

function describe(memory: Memory, now: Date): string {
  const details = [`重要程度 ${memory.importance.toFixed(1)}`]
  if (memory.category === 'plan' && memory.occurredAt) {
    details.push(`计划时间 ${formatDate(new Date(memory.occurredAt))}${memory.occurredAt < now.getTime() ? '（已过去）' : ''}`)
  }
  else if (memory.category === 'episodic') {
    details.push(`发生于 ${formatDate(new Date(memory.occurredAt ?? memory.createdAt))}`)
  }
  else {
    details.push(`记录于 ${formatDate(new Date(memory.createdAt))}`)
  }
  if (memory.updatedAt !== memory.createdAt) details.push(`更新于 ${formatDate(new Date(memory.updatedAt))}`)
  if (memory.accessCount > 0) details.push(`被想起 ${memory.accessCount} 次`)
  return `- [id ${memory.id}] ${memory.content}（${details.join('，')}）`
}

export function buildConsolidationPrompt(memories: Memory[], now: Date): string {
  const category = memories[0] ? categoryLabel(memories[0].category) : ''
  return `# 记忆（${category}，共 ${memories.length} 条）\n${memories.map((memory) => describe(memory, now)).join('\n')}`
}

/** 让 LLM 给出一组记忆的整理操作 */
export async function planConsolidation(options: {
  model: LanguageModel
  memories: Memory[]
  now?: Date
  abortSignal?: AbortSignal
}): Promise<ConsolidationOperation[]> {
  const { model, memories, now = new Date(), abortSignal } = options
  if (memories.length < 2) return []
  const { text } = await generateText({
    model,
    system: buildConsolidationSystemPrompt(now),
    prompt: buildConsolidationPrompt(memories, now),
    temperature: 0,
    abortSignal,
  })
  return parseConsolidation(text, memories)
}

/**
 * 记忆整理：逐组交给 LLM，合并重复与矛盾的记忆、归纳习惯、改写含糊的表述、归档失效的记忆。
 * 所有变动属于同一批，可以整批撤销
 */
export async function consolidateMemories(options: {
  model: LanguageModel
  groups: Memory[][]
  embed?: Embedder
  batch: string
  now?: Date
  abortSignal?: AbortSignal
  onProgress?: (done: number, total: number) => void
}): Promise<ConsolidationResult> {
  const { model, groups, embed, batch, now = new Date(), abortSignal, onProgress } = options
  const change = { source: CONSOLIDATE_SOURCE, batch }
  const result: ConsolidationResult = { groups: groups.length, merged: 0, updated: 0, archived: 0, batch }

  for (const [index, memories] of groups.entries()) {
    onProgress?.(index, groups.length)
    const operations = await planConsolidation({ model, memories, now, abortSignal })
    const known = new Map(memories.map((memory) => [memory.id, memory]))

    // 合并、改写后的内容重新生成向量
    const rewritten = operations.flatMap((operation) => (operation.type === 'archive' ? [] : [operation.content]))
    const embeddings = await safeEmbed(embed, rewritten)
    let embeddingIndex = 0
    const nextEmbedding = () => {
      const embedding = embeddings?.embeddings[embeddingIndex++]
      return embedding ? { embedding, embeddingModel: embeddings!.model } : {}
    }

    for (const operation of operations) {
      if (operation.type === 'merge') {
        const target = mergeTarget(operation.ids.map((id) => known.get(id)!))
        await api.updateMemory(target.id, {
          content: operation.content,
          category: operation.category,
          importance: operation.importance,
          ...nextEmbedding(),
        }, change)
        result.archived += await api.archiveMemories(operation.ids.filter((id) => id !== target.id), change)
        result.merged++
      }
      else if (operation.type === 'update') {
        await api.updateMemory(operation.id, {
          content: operation.content,
          category: operation.category,
          importance: operation.importance,
          ...nextEmbedding(),
        }, change)
        result.updated++
      }
      else {
        result.archived += await api.archiveMemories(operation.ids, change)
      }
    }
  }
  onProgress?.(groups.length, groups.length)
  return result
}
