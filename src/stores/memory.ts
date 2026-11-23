import type { EmbeddingModel, LanguageModel, ModelMessage } from 'ai'
import type { ConsolidationResult } from '@/memory/consolidate'
import type { MemoryDialogMessage } from '@/memory/extract'
import type { MemoryQuery } from '@/memory/recall'
import type {
  ListedMemory,
  Memory,
  MemoryPatch,
  MemoryStats,
  MemoryUpdate,
  MemoryWeights,
  NewMemory,
  ScoredMemory,
  SearchResult,
} from '@/memory/types'
import type { ModelChoice } from '@/stores/agent'
import { StorageSerializers, useLocalStorage } from '@vueuse/core'
import { embed, embedMany } from 'ai'
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import * as api from '@/memory/api'
import { consolidateMemories } from '@/memory/consolidate'
import { buildMemoryQuery, formatMemoryFacts, formatMemoryPrompt } from '@/memory/recall'
import { DEFAULT_WEIGHTS } from '@/memory/types'
import { memorizeTurn } from '@/memory/writer'
import { usePersonaStore } from '@/stores/persona'
import { useProvidersStore } from '@/stores/providers'
import { resolveEmbeddingModel, resolveLanguageModel, supportsEmbedding } from '@/utils/llm'

// 生成查询向量的超时时间，超时后退化为关键词匹配，避免拖慢回复
const EMBED_TIMEOUT = 5000
// 补全向量时每批处理的记忆数量
const BACKFILL_BATCH = 32
// 整理一轮对话的记忆（提取 + 合并）的超时时间
const MEMORIZE_TIMEOUT = 90_000
// 一次记忆整理的超时时间
const CONSOLIDATE_TIMEOUT = 10 * 60_000
// 整理时每组最多交给 LLM 的记忆数量
const CONSOLIDATE_GROUP_SIZE = 40
// 自动整理与遗忘的最小间隔
const MAINTENANCE_INTERVAL = 24 * 60 * 60_000
// 上次整理后，至少有这么多新增或修改的记忆才自动整理
const CONSOLIDATE_MIN_CHANGES = 20
// 记忆变动后，等待一段时间再检查是否需要自动整理与遗忘，避免频繁检查
const MAINTENANCE_DELAY = 15_000

export interface RecallResult {
  memories: ScoredMemory[]
  /** 写入角色扮演阶段系统提示词的内容 */
  prompt: string
  /** 提供给工具执行阶段的背景信息 */
  facts: string
  /** 是否使用了语义匹配 */
  semantic: boolean
}

export interface ForgetResult {
  memories: ListedMemory[]
  /** 本次遗忘的批次，可以整批撤销 */
  batch: string
}

// 长期记忆：对话时检索相关记忆并写入 Prompt；每轮对话后提取值得记住的信息写入记忆库；定期整理与遗忘
export const useMemoryStore = defineStore('memory', () => {
  const providersStore = useProvidersStore()
  const personaStore = usePersonaStore()

  const available = api.memoryAvailable
  // 是否在对话时检索记忆
  const enabled = useLocalStorage('settings/memory/enabled', true)
  // 生成向量的模型；为 null 时只按关键词匹配
  const embeddingModel = useLocalStorage<ModelChoice | null>('settings/memory/embeddingModel', null, { serializer: StorageSerializers.object })
  // 是否在每轮对话后自动整理记忆（提取、去重、合并）
  const autoMemorize = useLocalStorage('settings/memory/autoMemorize', true)
  // 是否定期自动整理记忆库（合并重复与矛盾的记忆等）
  const autoConsolidate = useLocalStorage('settings/memory/autoConsolidate', true)
  // 是否定期自动遗忘记忆强度过低的记忆
  const autoForget = useLocalStorage('settings/memory/autoForget', true)
  // 每次最多召回的记忆数量（不含核心档案）
  const limit = useLocalStorage('settings/memory/limit', 6)
  // 综合排名的权重
  const weights = useLocalStorage<MemoryWeights>('settings/memory/weights', { ...DEFAULT_WEIGHTS }, { mergeDefaults: true })
  // 上次整理与遗忘的时间
  const lastConsolidatedAt = useLocalStorage('memory/lastConsolidatedAt', 0)
  const lastForgotAt = useLocalStorage('memory/lastForgotAt', 0)

  const stats = ref<MemoryStats | null>(null)
  // 最近一次检索或补全向量时的错误
  const lastError = ref('')
  // 最近一次整理或遗忘时的错误
  const maintenanceError = ref('')
  const backfilling = ref(false)
  // 是否正在整理对话中的记忆
  const memorizing = ref(false)
  // 正在进行的维护：整理（附带进度）或遗忘
  const maintaining = ref<{ kind: 'consolidate', done: number, total: number } | { kind: 'forget' } | null>(null)
  const lastConsolidation = ref<ConsolidationResult | null>(null)
  const lastForgetting = ref<ForgetResult | null>(null)
  // 记忆库每次变动时递增，界面据此刷新列表
  const revision = ref(0)

  function markChanged() {
    revision.value++
    refreshStats()
  }

  // ===== 模型 =====

  /** 当前配置的向量模型；未配置或配置失效时返回 null */
  function resolveEmbedding(): { model: EmbeddingModel, id: string } | null {
    const choice = embeddingModel.value
    if (!choice?.modelId) return null
    const provider = providersStore.getProviderById(choice.providerId)
    if (!provider || !supportsEmbedding(provider)) return null
    // 以模型 id 区分向量：只有同一模型生成的向量才能互相比较
    return { model: resolveEmbeddingModel(provider, choice.modelId), id: choice.modelId }
  }

  /** 整理记忆使用的模型：当前的对话模型 */
  function resolveChatModel(): LanguageModel | null {
    const provider = providersStore.getCurrentLLMProvider()
    return provider ? resolveLanguageModel(provider) : null
  }

  async function embedText(text: string) {
    const embedding = resolveEmbedding()
    if (!embedding) return null
    const result = await embed({ model: embedding.model, value: text, abortSignal: AbortSignal.timeout(EMBED_TIMEOUT), maxRetries: 0 })
    return { embedding: result.embedding, model: embedding.id }
  }

  /** 批量生成向量，供记忆写入与整理使用；未配置向量模型时返回 null */
  async function embedTexts(texts: string[]) {
    const embedding = resolveEmbedding()
    if (!embedding) return null
    const { embeddings } = await embedMany({ model: embedding.model, values: texts, abortSignal: AbortSignal.timeout(EMBED_TIMEOUT * 2) })
    return { embeddings, model: embedding.id }
  }

  // ===== 检索 =====

  /** 检索记忆：配置了向量模型时先生成查询向量（失败则退化为关键词匹配），再交给 Rust 端综合排名 */
  async function search(query: MemoryQuery, options: { touch?: boolean } = {}): Promise<SearchResult> {
    let embedded: Awaited<ReturnType<typeof embedText>> = null
    try {
      embedded = await embedText(query.text)
    }
    catch (error) {
      // 向量接口出错时退化为关键词匹配，不影响对话
      lastError.value = `生成查询向量失败，本次只按关键词匹配：${error instanceof Error ? error.message : String(error)}`
      console.warn('[memory]', lastError.value)
    }

    const result = await api.searchMemories({
      query: query.keywords,
      embedding: embedded?.embedding,
      embeddingModel: embedded?.model,
      limit: limit.value,
      weights: weights.value,
      touch: options.touch ?? true,
    })
    if (embedded && result.missingEmbeddings > 0) backfill()
    return result
  }

  /** 对话时调用：根据最新的用户消息检索相关记忆，并整理成 Prompt */
  async function recall(messages: ModelMessage[]): Promise<RecallResult | null> {
    if (!available || !enabled.value) return null
    const query = buildMemoryQuery(messages)
    if (!query) return null

    const result = await search(query)
    if (result.memories.length === 0) return null
    const now = Date.now()
    return {
      memories: result.memories,
      prompt: formatMemoryPrompt(result.memories, now),
      facts: formatMemoryFacts(result.memories, now),
      semantic: result.semantic,
    }
  }

  // ===== 后台任务 =====

  // 修改记忆库的后台任务（对话后整理、记忆整理、遗忘）按顺序逐个执行，避免同时去重导致重复写入
  let taskQueue: Promise<unknown> = Promise.resolve()

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = taskQueue.then(task)
    taskQueue = result.catch(() => {})
    return result
  }

  /**
   * 记忆写入：在每轮对话结束后调用，从最新一轮中提取值得记住的信息，与已有记忆去重、合并后写入。
   * 在后台排队执行，出错时只记录错误，返回空数组
   */
  function memorize(dialog: MemoryDialogMessage[], options: { model: LanguageModel, source: string, batch?: string }): Promise<MemoryUpdate[]> {
    if (!available || !autoMemorize.value) return Promise.resolve([])

    return enqueue(async () => {
      memorizing.value = true
      try {
        const updates = await memorizeTurn({
          model: options.model,
          dialog,
          assistantName: personaStore.currentPersona?.name || '桌宠',
          embed: embedTexts,
          source: options.source,
          batch: options.batch,
          abortSignal: AbortSignal.timeout(MEMORIZE_TIMEOUT),
        })
        if (updates.length > 0) {
          markChanged()
          // 生成向量失败或合并后清除了向量的记忆，在后台补全
          backfill()
          scheduleMaintenance()
        }
        return updates
      }
      catch (error) {
        lastError.value = `整理记忆失败：${error instanceof Error ? error.message : String(error)}`
        console.warn('[memory]', lastError.value)
        return []
      }
      finally {
        memorizing.value = false
      }
    })
  }

  /** 记忆整理：合并重复与矛盾的记忆、归纳习惯、改写含糊的表述、归档失效的记忆 */
  function consolidate(): Promise<ConsolidationResult> {
    return enqueue(async () => {
      const model = resolveChatModel()
      if (!model) throw new Error('未配置可用的 LLM Provider')

      maintaining.value = { kind: 'consolidate', done: 0, total: 0 }
      maintenanceError.value = ''
      try {
        const groups = await api.getConsolidationGroups(resolveEmbedding()?.id, CONSOLIDATE_GROUP_SIZE)
        const result = await consolidateMemories({
          model,
          groups,
          embed: embedTexts,
          batch: api.createBatchId('consolidate'),
          abortSignal: AbortSignal.timeout(CONSOLIDATE_TIMEOUT),
          onProgress: (done, total) => {
            maintaining.value = { kind: 'consolidate', done, total }
          },
        })
        lastConsolidatedAt.value = Date.now()
        lastConsolidation.value = result
        if (result.merged + result.updated + result.archived > 0) {
          markChanged()
          backfill()
        }
        return result
      }
      catch (error) {
        maintenanceError.value = `整理记忆失败：${error instanceof Error ? error.message : String(error)}`
        throw error
      }
      finally {
        maintaining.value = null
      }
    })
  }

  /** 遗忘：归档记忆强度过低、又不太重要的记忆（可以撤销或从归档中恢复） */
  function forget(): Promise<ForgetResult> {
    return enqueue(async () => {
      maintaining.value = { kind: 'forget' }
      maintenanceError.value = ''
      try {
        const batch = api.createBatchId('forget')
        const memories = await api.forgetMemories(undefined, { source: 'forget', batch })
        lastForgotAt.value = Date.now()
        lastForgetting.value = { memories, batch }
        if (memories.length > 0) markChanged()
        return { memories, batch }
      }
      catch (error) {
        maintenanceError.value = `遗忘失败：${error instanceof Error ? error.message : String(error)}`
        throw error
      }
      finally {
        maintaining.value = null
      }
    })
  }

  /** 按需自动整理与遗忘：每天最多一次；整理还需要自上次整理后有足够多的新记忆 */
  async function runMaintenance() {
    if (!available) return
    const now = Date.now()
    try {
      if (autoForget.value && now - lastForgotAt.value >= MAINTENANCE_INTERVAL) {
        await forget()
      }
      if (
        autoConsolidate.value
        && now - lastConsolidatedAt.value >= MAINTENANCE_INTERVAL
        && resolveChatModel()
        && await api.countChangesSince(lastConsolidatedAt.value) >= CONSOLIDATE_MIN_CHANGES
      ) {
        await consolidate()
      }
    }
    catch (error) {
      console.warn('[memory] 自动整理与遗忘失败：', error)
    }
  }

  let maintenanceTimer: ReturnType<typeof setTimeout> | undefined
  function scheduleMaintenance(delay = MAINTENANCE_DELAY) {
    clearTimeout(maintenanceTimer)
    maintenanceTimer = setTimeout(runMaintenance, delay)
  }

  /** 为缺少当前模型向量的记忆补全向量（换了向量模型、写入时没有配置模型、内容被修改或撤销） */
  async function backfill() {
    const embedding = resolveEmbedding()
    if (!available || !embedding || backfilling.value) return
    backfilling.value = true
    try {
      for (;;) {
        const pending = await api.getPendingEmbeddings(embedding.id, BACKFILL_BATCH)
        if (pending.length === 0) break
        const { embeddings } = await embedMany({ model: embedding.model, values: pending.map((item) => item.content) })
        const updated = await api.setEmbeddings(embedding.id, pending.map((item, index) => ({ id: item.id, embedding: embeddings[index]! })))
        if (updated === 0) break
      }
      lastError.value = ''
    }
    catch (error) {
      lastError.value = `补全向量失败：${error instanceof Error ? error.message : String(error)}`
      console.warn('[memory]', lastError.value)
    }
    finally {
      backfilling.value = false
      refreshStats()
    }
  }

  async function refreshStats() {
    if (!available) return
    try {
      stats.value = await api.getMemoryStats(resolveEmbedding()?.id)
    }
    catch (error) {
      lastError.value = error instanceof Error ? error.message : String(error)
    }
  }

  // ===== 手动管理 =====

  /** 新增一条记忆，配置了向量模型时同时生成向量 */
  async function addMemory(memory: NewMemory): Promise<Memory> {
    let embedded: Awaited<ReturnType<typeof embedText>> = null
    try {
      embedded = await embedText(memory.content)
    }
    catch (error) {
      console.warn('[memory] 生成向量失败，稍后补全：', error)
    }
    const created = await api.addMemory(
      { ...memory, embedding: embedded?.embedding, embeddingModel: embedded?.model },
      { source: 'manual', batch: api.createBatchId('manual') },
    )
    markChanged()
    return created
  }

  /** 编辑记忆；修改了内容时重新生成向量 */
  async function editMemory(id: number, patch: MemoryPatch): Promise<Memory> {
    let embedded: Awaited<ReturnType<typeof embedText>> = null
    if (patch.content !== undefined) {
      try {
        embedded = await embedText(patch.content)
      }
      catch (error) {
        console.warn('[memory] 生成向量失败，稍后补全：', error)
      }
    }
    const updated = await api.updateMemory(
      id,
      { ...patch, ...(embedded ? { embedding: embedded.embedding, embeddingModel: embedded.model } : {}) },
      { source: 'manual', batch: api.createBatchId('edit') },
    )
    markChanged()
    if (patch.content !== undefined && !embedded) backfill()
    return updated
  }

  async function restoreMemories(ids: number[]) {
    const restored = await api.restoreMemories(ids, { source: 'manual', batch: api.createBatchId('restore') })
    markChanged()
    return restored
  }

  async function deleteMemory(id: number) {
    await api.deleteMemory(id, { source: 'manual', batch: api.createBatchId('delete') })
    markChanged()
  }

  /** 撤销一批变动（如一轮对话后的整理、一次记忆整理）或一条变动 */
  async function undo(target: { batchId?: string, eventId?: number }) {
    const count = await api.undoMemoryChanges(target)
    markChanged()
    // 撤销后内容变了的记忆需要重新生成向量
    backfill()
    return count
  }

  // 换了向量模型后，为已有的记忆补全新模型的向量
  watch(embeddingModel, () => {
    refreshStats()
    backfill()
  }, { deep: true })

  if (available) {
    refreshStats()
    // 启动后在后台补全向量、按需整理与遗忘，不阻塞界面
    setTimeout(backfill, 3000)
    scheduleMaintenance(30_000)
  }

  return {
    available,
    enabled,
    autoMemorize,
    autoConsolidate,
    autoForget,
    embeddingModel,
    limit,
    weights,
    lastConsolidatedAt,
    lastForgotAt,
    stats,
    lastError,
    maintenanceError,
    backfilling,
    memorizing,
    maintaining,
    lastConsolidation,
    lastForgetting,
    revision,
    recall,
    search,
    memorize,
    consolidate,
    forget,
    backfill,
    refreshStats,
    markChanged,
    addMemory,
    editMemory,
    restoreMemories,
    deleteMemory,
    undo,
    resolveEmbedding,
  }
})
