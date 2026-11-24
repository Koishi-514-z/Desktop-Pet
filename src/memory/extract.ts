import type { LanguageModel } from 'ai'
import type { MemoryCategory } from '@/memory/types'
import { generateText } from 'ai'
import { z } from 'zod'
import { formatDateTime, parseJsonObject, truncate } from '@/agent/utils'

// 一轮对话最多提取的记忆数量
const MAX_MEMORIES = 8
// 单条记忆的最大长度（提示中要求不超过 120 字，留出余量）
const MAX_CONTENT_LENGTH = 240
// 交给记忆整理模块的上文与最新一轮对话中每条消息的长度
const CONTEXT_MESSAGE_LENGTH = 400
const TURN_MESSAGE_LENGTH = 2000
// 提取时参考的上文消息数量
const CONTEXT_SIZE = 6
// 用户的最新消息短于该长度时（如「嗯」）不提取；两个字的回答（如被问到名字时回答「小明」）也可能值得记住
const MIN_MESSAGE_LENGTH = 2

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

// 模型有时会用中文写类别，或者写成相近的说法
const CATEGORY_ALIASES: Record<string, MemoryCategory> = {
  用户档案: 'profile',
  档案: 'profile',
  个人信息: 'profile',
  偏好习惯: 'preference',
  偏好: 'preference',
  习惯: 'preference',
  喜好: 'preference',
  关系印象: 'relationship',
  关系: 'relationship',
  计划约定: 'plan',
  计划: 'plan',
  约定: 'plan',
  目标: 'plan',
  情景记忆: 'episodic',
  情景: 'episodic',
  事件: 'episodic',
  经历: 'episodic',
}

// 默认的重要程度：没有给出或无法识别时
const DEFAULT_IMPORTANCE = 0.5

// 只要求有内容，其余字段尽量识别，识别不了时用默认值，不因为格式问题丢掉整条记忆
const extractedSchema = z.object({
  content: z.string().trim().min(2),
  category: z.unknown().optional(),
  importance: z.unknown().optional(),
  occurredAt: z.unknown().optional(),
})

/** 识别类别：英文 id、中文名称或相近的说法；识别不了时作为情景记忆 */
function parseCategory(value: unknown): MemoryCategory {
  if (typeof value !== 'string') return 'episodic'
  const text = value.trim()
  const id = text.toLowerCase()
  if ((CATEGORIES as readonly string[]).includes(id)) return id as MemoryCategory
  return CATEGORY_ALIASES[text] ?? 'episodic'
}

/** 识别重要程度：数字或数字字符串，超出范围时截断；识别不了时为默认值 */
function parseImportance(value: unknown): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseFloat(value) : Number.NaN
  return Number.isFinite(number) ? Math.min(Math.max(number, 0), 1) : DEFAULT_IMPORTANCE
}

/** 从模型的输出中取出记忆列表：兼容 {"memories": [...]}、直接输出数组、每条记忆只写成一句话等情况 */
function memoryItems(text: string): unknown[] {
  const data = parseJsonObject(text)
  if (Array.isArray(data?.memories)) return data.memories
  const match = text.match(/\[[\s\S]*\]/)
  if (!match) return []
  try {
    const value: unknown = JSON.parse(match[0])
    return Array.isArray(value) ? value : []
  }
  catch {
    return []
  }
}

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

/** 解析 LLM 输出的记忆，只跳过没有内容的条目；类别、重要程度、时间识别不了时用默认值 */
export function parseExtractedMemories(text: string): ExtractedMemory[] {
  return memoryItems(text)
    // 只写成一句话的记忆
    .map((item) => (typeof item === 'string' ? { content: item } : item))
    .map((item) => extractedSchema.safeParse(item))
    .filter((result) => result.success)
    .map(({ data }) => {
      const category = parseCategory(data.category)
      const memory: ExtractedMemory = {
        content: data.content.slice(0, MAX_CONTENT_LENGTH),
        category,
        importance: parseImportance(data.importance),
      }
      // 只有情景记忆与计划约定需要记录时间
      const occurredAt = typeof data.occurredAt === 'string' ? parseLocalDateTime(data.occurredAt) : undefined
      if (occurredAt !== undefined && (category === 'episodic' || category === 'plan')) memory.occurredAt = occurredAt
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
- 记录关于用户本人（以及与用户相关的人和事）的信息，以及用户与${assistantName}之间的约定。只要以后聊天时可能用得上就记下来，宁可多记：重复的记忆会自动去重合并，不重要的会随时间淡忘。
- 除了用户直接说出的信息，也记录从用户的请求中能看出的情况，例如用户在做的事、在学的东西、在用的工具、关心的话题（如「用户在开发一个桌宠项目」「用户最近在准备考研」）。
- 用户的心情与近况（如最近很忙、今天考完试很开心、身体不舒服）可以作为情景记忆记录。
- 不要记录：常识和知识问答本身的内容；纯粹的寒暄（如「你好」「谢谢」「好的」）；${assistantName}自己说的话（用户认可的约定除外）；用户让${assistantName}翻译、解释、总结的文字内容本身；查询到的结果本身（如天气预报的数据）。
- 用户的玩笑、假设、反问不要当成事实；不太确定的信息也可以记录，但 importance 给低一些（0.2 ~ 0.4）。
- 用户要求忘掉的事情，以及「要求忘掉某事」这个请求本身，都不要记录。
- 每条记忆只写一件事，用简洁的中文第三人称陈述，以「用户」开头，不超过 120 字，脱离对话也能看懂（写清楚指代的对象）。
- 相对时间要换算成具体日期：情景记忆与计划约定在 occurredAt 中给出事件发生或计划进行的时间，格式为 YYYY-MM-DD，知道具体时刻时为 YYYY-MM-DD HH:mm；正文中不必重复日期。
- importance 表示重要程度（0 ~ 1）：
  - 0.9 ~ 1：核心身份信息，如姓名、希望被怎样称呼、生日、重大的人生经历
  - 0.7 ~ 0.8：重要的个人信息与计划，如职业、学校、居住地、重要的考试或面试、健康状况、强烈的喜恶
  - 0.4 ~ 0.6：一般的偏好、习惯与日常事件
  - 0.1 ~ 0.3：琐碎但可能有用的细节
- 对话中完全没有关于用户的信息时（如纯粹的寒暄或知识问答），才返回空数组。

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
${parts.context.length ? parts.context.map((message) => format(message, CONTEXT_MESSAGE_LENGTH)).join('\n') : '（无）'}

# 最新一轮对话（从这里提取）
${parts.turn.map((message) => format(message, TURN_MESSAGE_LENGTH)).join('\n')}`
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
  const memories = parseExtractedMemories(text)
  // 便于排查「为什么没有记住」：在控制台中查看模型的原始输出
  console.debug('[memory] 记忆提取：', memories.length ? memories : '（没有可记录的信息）', '\n模型输出：', text)
  return memories
}
