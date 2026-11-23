import type { LanguageModel } from 'ai'
import type { ExtractedMemory } from '@/memory/extract'
import type { MemoryCategory, SimilarMemory } from '@/memory/types'
import { generateText } from 'ai'
import { z } from 'zod'
import { formatDate, formatDateTime, parseJsonObject } from '@/agent/utils'
import { categoryLabel } from '@/memory/types'

// 合并后单条记忆的最大长度
const MAX_CONTENT_LENGTH = 150

/** 一条新记忆及与它相似的已有记忆 */
export interface MergeCandidate {
  fact: ExtractedMemory
  similar: SimilarMemory[]
}

/** 对一条新记忆的处理决定 */
export type MergeDecision =
  /** 新增 */
  | { action: 'add' }
  /** 与已有记忆重复，不写入；target 为重复的那条（会加深印象） */
  | { action: 'skip', target?: number }
  /** 与已有记忆合并：改写 target 的内容，并归档已被合并后的记忆完全包含的 remove */
  | { action: 'update', target: number, content: string, category: MemoryCategory, importance: number, remove: number[] }

const decisionSchema = z.object({
  index: z.coerce.number().int(),
  action: z.enum(['add', 'skip', 'update']),
  target: z.coerce.number().int().nullish(),
  content: z.string().nullish(),
  category: z.enum(['profile', 'preference', 'episodic', 'plan', 'relationship']).nullish(),
  importance: z.coerce.number().nullish(),
  remove: z.array(z.coerce.number().int()).nullish(),
})

/**
 * 解析 LLM 给出的决定，并逐条校验：
 * 只能引用提供给它的已有记忆；更新缺少内容、引用了未知的记忆、或漏掉了某条新记忆时，一律按新增处理。
 */
export function parseMergeDecisions(text: string, candidates: MergeCandidate[]): MergeDecision[] {
  const known = new Map<number, SimilarMemory>()
  candidates.forEach(({ similar }) => similar.forEach((memory) => known.set(memory.id, memory)))

  const data = parseJsonObject(text)
  const items = Array.isArray(data?.decisions) ? data.decisions : []
  const decisions: MergeDecision[] = candidates.map(() => ({ action: 'add' }))
  const decided = new Set<number>()

  for (const item of items) {
    const result = decisionSchema.safeParse(item)
    if (!result.success) continue
    const { index, action, target, content, category, importance, remove } = result.data
    const position = index - 1
    const candidate = candidates[position]
    if (!candidate || decided.has(position)) continue
    decided.add(position)

    const targetMemory = target == null ? undefined : known.get(target)
    if (action === 'skip') {
      decisions[position] = targetMemory ? { action: 'skip', target: targetMemory.id } : { action: 'skip' }
    }
    else if (action === 'update' && targetMemory && content?.trim()) {
      decisions[position] = {
        action: 'update',
        target: targetMemory.id,
        content: content.trim().slice(0, MAX_CONTENT_LENGTH),
        category: category ?? candidate.fact.category,
        importance: Number.isFinite(importance)
          ? Math.min(Math.max(importance!, 0), 1)
          : Math.max(candidate.fact.importance, targetMemory.importance),
        remove: [...new Set(remove ?? [])].filter((id) => id !== targetMemory.id && known.has(id)),
      }
    }
  }
  return decisions
}

function describeMemory(memory: SimilarMemory): string {
  const date = memory.category === 'episodic' || memory.category === 'plan'
    ? `，时间 ${formatDate(new Date(memory.occurredAt ?? memory.createdAt))}`
    : `，记录于 ${formatDate(new Date(memory.createdAt))}`
  return `- [id ${memory.id}] ${categoryLabel(memory.category)}｜${memory.content}（重要程度 ${memory.importance.toFixed(1)}${date}）`
}

export function buildMergeSystemPrompt(now: Date): string {
  return `你是桌宠的记忆整理模块，负责把从对话中新提取的记忆与记忆库中已有的记忆去重、合并。你的输出只给程序读取。

# 当前时间
${formatDateTime(now)}

# 处理方式
对每条新记忆给出一个决定：
- add：新记忆与已有记忆都不重复，直接新增。
- skip：新记忆的信息已经被某条已有记忆完全包含（重复），不需要写入。target 填写那条已有记忆的 id。
- update：新记忆补充、修正或推翻了某条已有记忆（如搬家、换工作、喜好改变、计划有变），把二者合并成一条最新、完整的记忆。target 填写被更新的已有记忆 id；content 填写合并后的完整内容，以「用户」开头，不超过 80 字，必要时保留「以前……」这样的历史信息；可以同时给出合并后的 category 与 importance。如果还有其他已有记忆的内容已被合并后的记忆完全包含，把它们的 id 填入 remove。

注意：
- 不同的具体事件（如两次不同的考试）是不同的情景记忆，不要合并。
- 只能使用下面列出的已有记忆 id。
- 拿不准是否重复时选 add。

# 输出格式
只输出一个 JSON 对象，每条新记忆都要有一个决定，例如：
{"decisions": [{"index": 1, "action": "add"}, {"index": 2, "action": "skip", "target": 12}, {"index": 3, "action": "update", "target": 8, "content": "用户在上海工作，以前住在杭州", "category": "profile", "importance": 0.8, "remove": [15]}]}`
}

export function buildMergePrompt(candidates: MergeCandidate[]): string {
  return candidates
    .map(({ fact, similar }, index) => {
      const time = fact.occurredAt ? `，时间 ${formatDate(new Date(fact.occurredAt))}` : ''
      return `# 新记忆 ${index + 1}
${categoryLabel(fact.category)}｜${fact.content}（重要程度 ${fact.importance.toFixed(1)}${time}）
相似的已有记忆：
${similar.map(describeMemory).join('\n')}`
    })
    .join('\n\n')
}

/** 第二阶段：让 LLM 判断新记忆与相似的已有记忆是新增、重复还是需要合并 */
export async function decideMerges(options: {
  model: LanguageModel
  candidates: MergeCandidate[]
  now?: Date
  abortSignal?: AbortSignal
}): Promise<MergeDecision[]> {
  const { model, candidates, now = new Date(), abortSignal } = options
  if (candidates.length === 0) return []

  const { text } = await generateText({
    model,
    system: buildMergeSystemPrompt(now),
    prompt: buildMergePrompt(candidates),
    temperature: 0,
    abortSignal,
  })
  return parseMergeDecisions(text, candidates)
}
