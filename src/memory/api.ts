import type {
  ForgetOptions,
  ListedMemory,
  Memory,
  MemoryCategory,
  MemoryEvent,
  MemoryPatch,
  MemoryStats,
  NewMemory,
  SearchRequest,
  SearchResult,
  SimilarMemory,
} from '@/memory/types'
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/composables/desktop'

// 对 Rust 端记忆数据库命令的封装。记忆数据库只在桌面应用中可用

/** 记忆数据库是否可用 */
export const memoryAvailable = isTauri

/** 变动的来源与批次：同一批的变动在撤销时一起撤销 */
export interface ChangeOptions {
  /** 如 chat:会话 id、manual、consolidate、forget */
  source?: string
  batch?: string
}

/** 生成批次 id，如 turn-xxx、edit-xxx */
export function createBatchId(kind: string): string {
  return `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!memoryAvailable) return Promise.reject(new Error('长期记忆需要在桌面应用中使用'))
  return invoke<T>(command, args)
}

function change(options: ChangeOptions = {}) {
  return { source: options.source ?? null, batch: options.batch ?? null }
}

// ===== 检索 =====

export function searchMemories(request: SearchRequest): Promise<SearchResult> {
  return call('memory_search', { request })
}

/** 找出与一段内容最相似的已有记忆，用于写入前去重 */
export function findSimilarMemories(request: { content: string, embedding?: number[], embeddingModel?: string, limit?: number }): Promise<SimilarMemory[]> {
  return call('memory_similar', { request })
}

/** 按 id 获取未归档的记忆 */
export function getMemories(ids: number[]): Promise<Memory[]> {
  return call('memory_get', { ids })
}

/** 按更新时间从新到旧列出记忆，附带当前的记忆强度；archived 为 true 时列出已归档的 */
export function listMemories(options: { category?: MemoryCategory, archived?: boolean, limit?: number, offset?: number } = {}): Promise<ListedMemory[]> {
  return call('memory_list', {
    category: options.category ?? null,
    archived: options.archived ?? null,
    limit: options.limit ?? null,
    offset: options.offset ?? null,
  })
}

export function getMemoryStats(embeddingModel?: string): Promise<MemoryStats> {
  return call('memory_stats', { embeddingModel: embeddingModel ?? null })
}

// ===== 写入 =====

export function addMemory(memory: NewMemory, options: ChangeOptions = {}): Promise<Memory> {
  return call('memory_add', { memory, ...change(options) })
}

/** 修改记忆；修改了内容但没有提供新向量时，旧向量会被清除，之后自动补全 */
export function updateMemory(id: number, patch: MemoryPatch, options: ChangeOptions = {}): Promise<Memory> {
  return call('memory_update', { id, patch, ...change(options) })
}

/** 用户再次提到已有的记忆：刷新更新时间，重要程度只升不降 */
export function reinforceMemory(id: number, importance?: number, options: ChangeOptions = {}): Promise<Memory> {
  return call('memory_reinforce', { id, importance: importance ?? null, ...change(options) })
}

/** 归档记忆（如已被合并到其他记忆中、被遗忘），返回实际归档的数量 */
export function archiveMemories(ids: number[], options: ChangeOptions = {}): Promise<number> {
  return call('memory_archive', { ids, ...change(options) })
}

/** 从归档中恢复记忆，返回实际恢复的数量 */
export function restoreMemories(ids: number[], options: ChangeOptions = {}): Promise<number> {
  return call('memory_restore', { ids, ...change(options) })
}

/** 永久删除记忆 */
export function deleteMemory(id: number, options: ChangeOptions = { source: 'manual' }): Promise<boolean> {
  return call('memory_delete', { id, ...change(options) })
}

// ===== 变动记录与撤销 =====

/** 最近的记忆变动记录，从新到旧 */
export function listMemoryEvents(limit = 50): Promise<MemoryEvent[]> {
  return call('memory_events', { limit })
}

/** 撤销一批变动或一条变动，返回撤销的变动数量 */
export function undoMemoryChanges(target: { batchId?: string, eventId?: number }): Promise<number> {
  return call('memory_undo', { batchId: target.batchId ?? null, eventId: target.eventId ?? null })
}

/** 某个时间之后由对话或手动产生的新增与修改数量 */
export function countChangesSince(since: number): Promise<number> {
  return call('memory_changes_since', { since })
}

// ===== 整理与遗忘 =====

/** 预览按遗忘曲线应该遗忘的记忆 */
export function previewForgetting(options?: ForgetOptions): Promise<ListedMemory[]> {
  return call('memory_forget_preview', { options: options ?? null })
}

/** 遗忘：归档记忆强度过低的记忆，返回被遗忘的记忆 */
export function forgetMemories(options: ForgetOptions | undefined, changeOptions: ChangeOptions = {}): Promise<ListedMemory[]> {
  return call('memory_forget', { options: options ?? null, ...change(changeOptions) })
}

/** 把记忆分成交给 LLM 整理的若干组 */
export function getConsolidationGroups(embeddingModel?: string, maxGroupSize?: number): Promise<Memory[][]> {
  return call('memory_consolidation_groups', { embeddingModel: embeddingModel ?? null, maxGroupSize: maxGroupSize ?? null })
}

// ===== 向量 =====

export function getPendingEmbeddings(model: string, limit: number): Promise<{ id: number, content: string }[]> {
  return call('memory_pending_embeddings', { model, limit })
}

export function setEmbeddings(model: string, items: { id: number, embedding: number[] }[]): Promise<number> {
  return call('memory_set_embeddings', { model, items })
}

export function getDatabasePath(): Promise<string | null> {
  return call('memory_database_path')
}
