import type { ModelMessage } from 'ai'
import type { ScoredMemory } from '@/memory/types'
import { formatDate, messageText, truncate } from '@/agent/utils'
import { MEMORY_CATEGORIES } from '@/memory/types'

// 查询中保留的最新用户消息与上文的长度
const LATEST_LENGTH = 800
const CONTEXT_LENGTH = 300
// 查询中保留的划词内容的开头长度
const QUOTE_LENGTH = 400
// 写入 Prompt 的记忆总字数上限，超出时舍弃排名靠后的记忆（核心档案除外）
const PROMPT_BUDGET = 3000

/** 去掉消息中的图片标记，划词内容只保留开头 */
function cleanText(text: string): string {
  return text
    .replace(/【附图：[\w-]+】/g, '')
    .replace(/【划词内容】\n([\s\S]*)$/, (_, quote: string) => `（引用：${truncate(quote.trim(), QUOTE_LENGTH)}）`)
    .trim()
}

export interface MemoryQuery {
  /** 用于生成查询向量：最新的用户消息，附带上一轮对话作为上下文（便于理解「那明天呢」这类省略） */
  text: string
  /** 用于关键词匹配：只取最新的用户消息，避免上文中的词带偏结果 */
  keywords: string
}

export function buildMemoryQuery(messages: ModelMessage[]): MemoryQuery | null {
  let latestIndex = messages.length - 1
  while (latestIndex >= 0 && messages[latestIndex]!.role !== 'user') latestIndex--
  if (latestIndex === -1) return null

  const latest = truncate(cleanText(messageText(messages[latestIndex]!)), LATEST_LENGTH)
  if (!latest) return null

  const previous = messages[latestIndex - 1]
  const context = previous ? truncate(cleanText(messageText(previous)), CONTEXT_LENGTH) : ''
  const text = context ? `${context}\n${latest}` : latest
  return { text, keywords: latest }
}

/** 记忆前的日期说明：情景记忆写明发生时间，计划写明计划时间 */
function datePrefix(memory: ScoredMemory, now: number): string {
  if (memory.category === 'episodic') return `（${formatDate(new Date(memory.occurredAt ?? memory.createdAt))}）`
  if (memory.category === 'plan' && memory.occurredAt) {
    return `（${memory.occurredAt >= now ? '计划于' : '原定于'} ${formatDate(new Date(memory.occurredAt))}）`
  }
  return ''
}

/** 按字数上限选取记忆：核心档案全部保留，其余按排名依次加入 */
function withinBudget(memories: ScoredMemory[]): ScoredMemory[] {
  let used = 0
  return memories.filter((memory) => {
    used += memory.content.length + 8
    return memory.core || used <= PROMPT_BUDGET
  })
}

function groupLines(memories: ScoredMemory[], now: number): string[] {
  return MEMORY_CATEGORIES.flatMap((category) => {
    const items = memories.filter((memory) => memory.category === category.id)
    if (items.length === 0) return []
    return [`## ${category.label}`, ...items.map((memory) => `- ${datePrefix(memory, now)}${memory.content}`)]
  })
}

/** 写入角色扮演阶段系统提示词的记忆 */
export function formatMemoryPrompt(memories: ScoredMemory[], now = Date.now()): string {
  const selected = withinBudget(memories)
  if (selected.length === 0) return ''

  return `# 关于用户的记忆

以下是你记得的、可能与当前对话有关的事情（今天是 ${formatDate(new Date(now))}）。请在合适的时候自然地运用，比如称呼对方、关心近况、延续之前的话题；不要生硬地逐条复述，也不要提及「记忆」「数据库」之类的字眼。这些记忆可能已经过时，与用户最新的说法冲突时以用户为准；与当前话题无关的记忆不必理会。

${groupLines(selected, now).join('\n')}`
}

/** 提供给工具执行阶段的背景信息，便于推断缺省的参数（如所在城市） */
export function formatMemoryFacts(memories: ScoredMemory[], now = Date.now()): string {
  const selected = withinBudget(memories)
  if (selected.length === 0) return ''
  return `# 关于用户的已知信息（来自长期记忆，可用于推断用户没有明说的参数，如所在城市；可能已过时）\n${groupLines(selected, now).join('\n')}`
}
