import type { LanguageModel } from 'ai'
import type { MemoryCategory } from '@/memory/types'
import { generateText } from 'ai'
import { z } from 'zod'
import { formatDateTime, parseJsonObject, truncate } from '@/agent/utils'

// 一轮对话最多提取的记忆数量
const MAX_MEMORIES = 8
// 单条记忆的最大长度
const MAX_CONTENT_LENGTH = 120
// 提取时参考的上文消息数量
const CONTEXT_SIZE = 6
// 用户的最新消息短于该长度时（如「嗯」「好的」）不提取
const MIN_MESSAGE_LENGTH = 3

/** 交给记忆整理模块的对话消息 */
export interface MemoryDialogMessage {
  role: 'user' | 'assistant'
  content: string
}

/** 从对话中提取出的记忆 */
export interface ExtractedMemory {
  content: string
  category: MemoryCategory
  /** 重要程度，0 ~ 1 */
  importance: number
  /** 事件发生（或计划进行）的时间，仅情景记忆与计划约定有 */
  occurredAt?: number
}

const CATEGORIES = ['profile', 'preference', 'episodic', 'plan', 'relationship'] as const

const extractedSchema = z.object({
  content: z.string().trim().min(2),
  category: z.enum(CATEGORIES),
  importance: z.coerce.number().optional(),
  occurredAt: z.string().nullish(),
})

/** 解析 YYYY-MM-DD 或 YYYY-MM-DD HH:mm 格式的本地时间，无效时返回 undefined */
export function parseLocalDateTime(value: string | null | undefined): number | undefined {
  const match = value?.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2})?)?$/)
  if (!match) return undefined
  const [year, month, day, hour = 0, minute = 0] = match.slice(1).map((v) => (v === undefined ? undefined : Number(v))) as number[]
  const date = new Date(year!, month! - 1, day!, hour, minute)
  // 拒绝 2026-02-30 这类会被自动进位的日期
  if (date.getFullYear() !== year || date.getMonth() !== month! - 1 || date.getDate() !== day) return undefined
  return date.getTime()
}

/** 解析 LLM 输出的记忆，跳过格式不正确的条目 */
export function parseExtractedMemories(text: string): ExtractedMemory[] {
  const data = parseJsonObject(text)
  const items = Array.isArray(data?.memories) ? data.memories : []

  return items
    .map((item) => extractedSchema.safeParse(item))
    .filter((result) => result.success)
    .map(({ data }) => {
      const memory: ExtractedMemory = {
        content: data.content.slice(0, MAX_CONTENT_LENGTH),
        category: data.category,
        importance: Number.isFinite(data.importance) ? Math.min(Math.max(data.importance!, 0), 1) : 0.5,
      }
      // 只有情景记忆与计划约定需要记录时间
      const occurredAt = parseLocalDateTime(data.occurredAt)
      if (occurredAt !== undefined && (data.category === 'episodic' || data.category === 'plan')) memory.occurredAt = occurredAt
      return memory
    })
    .slice(0, MAX_MEMORIES)
}

/** 最新一轮对话：最后一条用户消息及其之后的回复；之前的消息作为上下文 */
export function splitLatestTurn(dialog: MemoryDialogMessage[]) {
  let index = dialog.length - 1
  while (index >= 0 && dialog[index]!.role !== 'user') index--
  if (index === -1) return null
  return { context: dialog.slice(Math.max(0, index - CONTEXT_SIZE), index), turn: dialog.slice(index) }
}

export function buildExtractionSystemPrompt(assistantName: string, now: Date): string {
  return `你是桌宠「${assistantName}」的记忆整理模块，负责从对话中找出值得长期记住的、关于用户的信息。你的输出只给程序读取，不会展示给用户。

# 当前时间
${formatDateTime(now)}

# 记忆类别
- profile（用户档案）：姓名或称呼、年龄、生日、职业、学校、居住地、家庭成员等相对稳定的个人信息
- preference（偏好习惯）：喜欢与不喜欢的事物、兴趣爱好、生活习惯、作息、饮食口味
- relationship（关系印象）：用户希望${assistantName}怎样称呼或对待自己、用户对${assistantName}的态度、两人关系的重要变化
- plan（计划约定）：用户的计划、目标、待办，以及用户与${assistantName}之间的约定
- episodic（情景记忆）：用户经历或分享的具体事件，如考试、面试、旅行、生病、取得成就

# 提取规则
- 只提取「最新一轮对话」中新出现的信息，更早的对话只用来理解上下文。
- 只记录关于用户本人（以及与用户相关的人和事）的信息，以及用户与${assistantName}之间的约定。
- 不要记录：常识和知识问答的内容；没有长期价值的闲聊；只在当下有意义的状态（如「用户说好的」「用户笑了」）；${assistantName}自己说的话（用户认可的约定除外）；用户让${assistantName}翻译、解释、总结的文字内容；查询到的结果（如天气）。
- 用户的玩笑、假设、反问不要当成事实；拿不准的信息不要记录。
- 用户要求忘掉的事情，以及「要求忘掉某事」这个请求本身，都不要记录。
- 每条记忆只写一件事，用简洁的中文第三人称陈述，以「用户」开头，不超过 60 字，脱离对话也能看懂（写清楚指代的对象）。
- 相对时间要换算成具体日期：情景记忆与计划约定在 occurredAt 中给出事件发生或计划进行的时间，格式为 YYYY-MM-DD，知道具体时刻时为 YYYY-MM-DD HH:mm；正文中不必重复日期。
- importance 表示重要程度（0 ~ 1）：
  - 0.9 ~ 1：核心身份信息，如姓名、希望被怎样称呼、生日、重大的人生经历
  - 0.7 ~ 0.8：重要的个人信息与计划，如职业、学校、居住地、重要的考试或面试、健康状况、强烈的喜恶
  - 0.4 ~ 0.6：一般的偏好、习惯与日常事件
  - 0.1 ~ 0.3：琐碎但可能有用的细节
- 大多数对话都没有值得记住的信息，此时返回空数组。

# 输出格式
只输出一个 JSON 对象，不要输出任何其他内容，例如：
{"memories": [{"content": "用户叫小明", "category": "profile", "importance": 0.9}, {"content": "用户有一场软件工程师岗位的面试", "category": "plan", "importance": 0.7, "occurredAt": "2026-11-25 14:00"}]}
没有需要记住的信息时输出：{"memories": []}`
}

export function buildExtractionPrompt(dialog: MemoryDialogMessage[], assistantName: string): string {
  const parts = splitLatestTurn(dialog)
  if (!parts) return ''
  const format = (message: MemoryDialogMessage, length: number) =>
    `${message.role === 'user' ? '用户' : assistantName}：${truncate(message.content, length)}`

  return `# 之前的对话（仅供理解上下文）
${parts.context.length ? parts.context.map((message) => format(message, 200)).join('\n') : '（无）'}

# 最新一轮对话（从这里提取）
${parts.turn.map((message) => format(message, 1000)).join('\n')}`
}

/** 第一阶段：从最新一轮对话中提取值得记住的信息 */
export async function extractMemories(options: {
  model: LanguageModel
  dialog: MemoryDialogMessage[]
  assistantName: string
  now?: Date
  abortSignal?: AbortSignal
}): Promise<ExtractedMemory[]> {
  const { model, dialog, assistantName, now = new Date(), abortSignal } = options
  const parts = splitLatestTurn(dialog)
  const latest = parts?.turn[0]?.content.trim() ?? ''
  // 太短的消息（如「嗯」「好的」）不值得调用模型
  if (latest.length < MIN_MESSAGE_LENGTH) return []

  const { text } = await generateText({
    model,
    system: buildExtractionSystemPrompt(assistantName, now),
    prompt: buildExtractionPrompt(dialog, assistantName),
    temperature: 0,
    abortSignal,
  })
  return parseExtractedMemories(text)
}
