// 与 Rust 端 memory 模块对应的数据结构

export type MemoryCategory = 'profile' | 'preference' | 'episodic' | 'plan' | 'relationship'

export interface MemoryCategoryInfo {
  id: MemoryCategory
  label: string
  description: string
  /** 新近程度的半衰期，仅用于界面说明（实际计算在 Rust 端） */
  halfLife: string
}

// 按写入 Prompt 时的顺序排列
export const MEMORY_CATEGORIES: MemoryCategoryInfo[] = [
  { id: 'profile', label: '用户档案', description: '姓名、职业、居住地等相对稳定的个人信息', halfLife: '不衰减' },
  { id: 'preference', label: '偏好习惯', description: '喜好、厌恶、习惯、作息', halfLife: '180 天' },
  { id: 'relationship', label: '关系印象', description: '对用户的整体印象、彼此关系的变化', halfLife: '90 天' },
  { id: 'plan', label: '计划约定', description: '用户的计划、目标，以及与桌宠的约定', halfLife: '21 天' },
  { id: 'episodic', label: '情景记忆', description: '与用户之间发生过的具体事件', halfLife: '30 天' },
]

export function categoryLabel(category: MemoryCategory): string {
  return MEMORY_CATEGORIES.find((item) => item.id === category)?.label ?? category
}

export interface Memory {
  id: number
  category: MemoryCategory
  content: string
  /** 重要程度，0 ~ 1 */
  importance: number
  /** 事件发生（或计划进行）的时间，毫秒时间戳 */
  occurredAt: number | null
  createdAt: number
  updatedAt: number
  lastAccessedAt: number | null
  accessCount: number
  source: string | null
  /** 生成向量所用的模型，为空表示还没有向量 */
  embeddingModel: string | null
  /** 已归档（被合并、遗忘或撤销）的记忆不再参与检索，可以恢复 */
  archived: boolean
  /** 固定的记忆不会被自动整理或遗忘 */
  pinned: boolean
}

/** 记忆库列表中的记忆，附带当前的记忆强度 */
export interface ListedMemory extends Memory {
  /** 记忆强度（按遗忘曲线计算），0 ~ 1 */
  retention: number
}

export interface ScoredMemory extends Memory {
  /** 综合得分 */
  score: number
  /** 相关性，0 ~ 1 */
  relevance: number
  /** 新近程度，0 ~ 1 */
  recency: number
  /** 是否为每次都会附带的核心档案 */
  core: boolean
}

export interface MemoryWeights {
  relevance: number
  importance: number
  recency: number
}

export const DEFAULT_WEIGHTS: MemoryWeights = { relevance: 0.6, importance: 0.25, recency: 0.15 }

export interface SearchRequest {
  query: string
  embedding?: number[]
  embeddingModel?: string
  limit?: number
  coreLimit?: number
  weights?: MemoryWeights
  now?: number
  /** 是否记录访问，默认为 true */
  touch?: boolean
}

export interface SearchResult {
  memories: ScoredMemory[]
  /** 是否使用了语义匹配 */
  semantic: boolean
  /** 没有当前模型向量的记忆数量 */
  missingEmbeddings: number
}

export interface NewMemory {
  category: MemoryCategory
  content: string
  importance?: number
  occurredAt?: number
  source?: string
  embedding?: number[]
  embeddingModel?: string
}

export interface MemoryStats {
  total: number
  byCategory: [MemoryCategory, number][]
  missingEmbeddings: number
  /** 已归档的记忆数量 */
  archived: number
}

/** 回复中召回的记忆（保存在聊天记录中，用于界面展示） */
export interface RecalledMemory {
  id: number
  category: MemoryCategory
  content: string
  core: boolean
}

/** 与一段内容相似的已有记忆（写入前去重用） */
export interface SimilarMemory extends Memory {
  /** 语义相似度（余弦相似度），没有可比较的向量时为空 */
  similarity: number | null
  /** 关键词匹配得分，0 ~ 1 */
  lexical: number
}

/** 修改记忆的参数，省略的字段保持不变 */
export interface MemoryPatch {
  content?: string
  category?: MemoryCategory
  importance?: number
  occurredAt?: number
  pinned?: boolean
  embedding?: number[]
  embeddingModel?: string
}

export type MemoryEventAction = 'add' | 'update' | 'reinforce' | 'archive' | 'restore' | 'delete'

export const MEMORY_EVENT_LABELS: Record<MemoryEventAction, string> = {
  add: '新增',
  update: '更新',
  reinforce: '再次提到',
  archive: '归档',
  restore: '恢复',
  delete: '删除',
}

/** 记忆的变动记录 */
export interface MemoryEvent {
  id: number
  memoryId: number
  action: MemoryEventAction
  category: MemoryCategory
  /** 变动后的内容（删除、归档时为被删除的内容） */
  content: string
  /** 修改前的内容 */
  previous: string | null
  /** 变动来源：chat:会话 id（对话后整理）、manual（手动）、consolidate（整理）、forget（遗忘）、skill（对话中要求） */
  source: string | null
  /** 同一次操作产生的变动属于同一批，撤销时整批撤销 */
  batchId: string | null
  createdAt: number
  /** 被撤销的时间 */
  undoneAt: number | null
  /** 现在能否撤销 */
  undoable: boolean
}

/** 遗忘的条件，省略的字段使用默认值 */
export interface ForgetOptions {
  /** 记忆强度低于该值的记忆会被遗忘，默认 0.15 */
  threshold?: number
  /** 重要程度不低于该值的记忆不会被遗忘，默认 0.6 */
  maxImportance?: number
  /** 新写入的记忆在这么多天内不会被遗忘，默认 7 */
  graceDays?: number
}

/** 来源的显示名称 */
export function sourceLabel(source: string | null): string {
  if (!source) return ''
  if (source.startsWith('chat:')) return '对话'
  return ({ manual: '手动', consolidate: '整理', forget: '遗忘', skill: '对话中要求' } as Record<string, string>)[source] ?? source
}

/** 一轮对话后记忆的变动 */
export interface MemoryUpdate {
  action: 'add' | 'update' | 'reinforce'
  memoryId: number
  category: MemoryCategory
  content: string
  /** 更新前的内容 */
  previous?: string
  /** 一并合并掉的其他记忆数量 */
  merged?: number
}

/** 回复中记住的事情（保存在聊天记录中，用于界面展示） */
export interface RememberedMemory {
  action: 'add' | 'update'
  category: MemoryCategory
  content: string
  previous?: string
}
