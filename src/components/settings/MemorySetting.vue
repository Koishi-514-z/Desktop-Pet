<script setup lang="ts">
import type { MemoryWeights, SearchResult } from '@/memory/types'
import { computed, onMounted, ref } from 'vue'
import { getDatabasePath } from '@/memory/api'
import { categoryLabel, DEFAULT_WEIGHTS } from '@/memory/types'
import { useMemoryStore } from '@/stores/memory'
import { useProvidersStore } from '@/stores/providers'
import { supportsEmbedding } from '@/utils/llm'
import MemoryHistory from './memory/MemoryHistory.vue'
import MemoryLibrary from './memory/MemoryLibrary.vue'
import MemoryMaintenance from './memory/MemoryMaintenance.vue'

const memoryStore = useMemoryStore()
const providersStore = useProvidersStore()

const databasePath = ref('')

// ===== 向量模型 =====

const embeddingProviders = computed(() => providersStore.getLLMProviders().filter(supportsEmbedding))

const embeddingProviderId = computed({
  get: () => memoryStore.embeddingModel?.providerId ?? '',
  set: (id: string) => {
    memoryStore.embeddingModel = id ? { providerId: id, modelId: memoryStore.embeddingModel?.modelId ?? '' } : null
  },
})

const embeddingModelId = computed({
  get: () => memoryStore.embeddingModel?.modelId ?? '',
  set: (modelId: string) => {
    if (memoryStore.embeddingModel) memoryStore.embeddingModel = { ...memoryStore.embeddingModel, modelId: modelId.trim() }
  },
})

// 优先列出看起来是向量模型的模型
const embeddingModelOptions = computed(() => {
  const models = providersStore.getProviderById(embeddingProviderId.value)?.models ?? []
  const embeddings = models.filter((model) => /embed|bge|m3e|gte|bce|e5/i.test(model.id))
  return embeddings.length ? embeddings : models
})

const embeddingReady = computed(() => !!memoryStore.resolveEmbedding())

// ===== 排名权重 =====

const WEIGHT_ITEMS: { key: keyof MemoryWeights, label: string, desc: string }[] = [
  { key: 'relevance', label: '相关性', desc: '与当前话题的语义（或关键词）相关程度' },
  { key: 'importance', label: '重要程度', desc: '记忆写入时评估的重要性' },
  { key: 'recency', label: '新近程度', desc: '越新的记忆越优先，不同类别衰减速度不同' },
]

function weightPercent(key: keyof MemoryWeights) {
  const weights = memoryStore.weights
  const sum = weights.relevance + weights.importance + weights.recency
  return sum > 0 ? Math.round((weights[key] / sum) * 100) : 0
}

function resetWeights() {
  memoryStore.weights = { ...DEFAULT_WEIGHTS }
}

// ===== 检索测试 =====

const testQuery = ref('')
const testResult = ref<SearchResult | null>(null)
const testing = ref(false)
const testError = ref('')

async function runTest() {
  const query = testQuery.value.trim()
  if (!query) return
  testing.value = true
  testError.value = ''
  try {
    // 测试检索不记录访问，避免影响记忆的统计
    testResult.value = await memoryStore.search({ text: query, keywords: query }, { touch: false })
  }
  catch (error) {
    testError.value = error instanceof Error ? error.message : String(error)
  }
  finally {
    testing.value = false
  }
}

onMounted(async () => {
  if (!memoryStore.available) return
  memoryStore.refreshStats()
  databasePath.value = (await getDatabasePath().catch(() => null)) ?? ''
})
</script>

<template>
  <div class="scene-setting memory-setting">
    <section class="tile">
      <header class="tile-head">
        <span class="tile-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3a6 6 0 0 0-6 6c0 2.2 1.2 3.6 2.2 4.6.6.6.8 1.2.8 2V17h6v-1.4c0-.8.2-1.4.8-2 1-1 2.2-2.4 2.2-4.6a6 6 0 0 0-6-6zM10 21h4" />
          </svg>
        </span>
        <span class="tile-title">长期记忆</span>
      </header>

      <label class="toggle-setting">
        <span class="setting-label">
          <span>对话时回忆</span>
          <span class="setting-desc">每次回复前，从记忆库中找出与当前话题最相关的记忆写入 Prompt，让桌宠记得你说过的事</span>
        </span>
        <span class="switch">
          <input v-model="memoryStore.enabled" type="checkbox" :disabled="!memoryStore.available" />
          <span class="switch-track" />
        </span>
      </label>
      <label class="toggle-setting">
        <span class="setting-label">
          <span>自动记忆</span>
          <span class="setting-desc">每轮对话后，由对话模型从中提取值得记住的信息（类别、重要程度），并与已有记忆去重、合并。每轮会多一次模型调用，有新信息且记忆库中有相似记忆时再多一次</span>
        </span>
        <span class="switch">
          <input v-model="memoryStore.autoMemorize" type="checkbox" :disabled="!memoryStore.available" />
          <span class="switch-track" />
        </span>
      </label>
      <span v-if="memoryStore.memorizing" class="setting-desc">正在整理刚才的对话…</span>
      <span v-if="!memoryStore.available" class="setting-desc warn">长期记忆保存在本地的 SQLite 数据库中，需要在桌面应用中使用</span>
      <span v-else-if="databasePath" class="setting-desc path">数据库：{{ databasePath }}</span>
    </section>

    <template v-if="memoryStore.available">
      <section class="tile">
        <header class="tile-head">
          <span class="tile-icon">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          </span>
          <span class="tile-title">检索</span>
        </header>

        <div class="setting">
          <div class="setting-label">
            <span>向量模型</span>
            <span class="setting-desc">用于判断语义相关性，如 text-embedding-3-small、bge-m3。未配置时只按关键词匹配</span>
          </div>
          <div class="row">
            <select v-model="embeddingProviderId" class="field">
              <option value="">不使用（只按关键词匹配）</option>
              <option v-for="provider in embeddingProviders" :key="provider.id" :value="provider.id">{{ provider.name }}</option>
            </select>
            <template v-if="memoryStore.embeddingModel">
              <input v-model.lazy="embeddingModelId" class="field" list="embedding-models" placeholder="模型 ID" />
              <datalist id="embedding-models">
                <option v-for="model in embeddingModelOptions" :key="model.id" :value="model.id">{{ model.name }}</option>
              </datalist>
            </template>
          </div>
          <span v-if="memoryStore.backfilling" class="setting-desc">正在为已有的记忆生成向量…</span>
          <span v-else-if="embeddingReady && memoryStore.stats?.missingEmbeddings" class="setting-desc warn">
            有 {{ memoryStore.stats.missingEmbeddings }} 条记忆还没有当前模型的向量，只能按关键词匹配
            <button class="link-button" type="button" @click="memoryStore.backfill()">立即生成</button>
          </span>
          <span v-else-if="embeddingReady" class="setting-desc ok">语义检索已启用</span>
          <span v-else-if="memoryStore.embeddingModel" class="setting-desc warn">请填写模型 ID</span>
          <span v-if="memoryStore.lastError" class="setting-desc warn">{{ memoryStore.lastError }}</span>
        </div>

        <div class="setting">
          <div class="setting-label">
            <span>每次最多回忆</span>
            <span class="setting-desc">不含每次都会带上的核心档案（重要程度 ≥ 0.8 的用户档案）</span>
          </div>
          <div class="row">
            <input v-model.number="memoryStore.limit" class="volume-slider" type="range" min="1" max="15" step="1" :style="{ '--fill': `${(memoryStore.limit - 1) / 14 * 100}%` }" />
            <span class="value">{{ memoryStore.limit }} 条</span>
          </div>
        </div>

        <div class="setting">
          <div class="setting-label">
            <span>排名权重</span>
            <span class="setting-desc">综合得分 = 相关性 × 权重 + 重要程度 × 权重 + 新近程度 × 权重（按比例换算）</span>
          </div>
          <div v-for="item in WEIGHT_ITEMS" :key="item.key" class="weight" :title="item.desc">
            <span class="weight-label">{{ item.label }}</span>
            <input
              v-model.number="memoryStore.weights[item.key]"
              class="volume-slider"
              type="range"
              min="0"
              max="1"
              step="0.05"
              :style="{ '--fill': `${memoryStore.weights[item.key] * 100}%` }"
            />
            <span class="value">{{ weightPercent(item.key) }}%</span>
          </div>
          <button class="reset-button align-start" type="button" @click="resetWeights">恢复默认</button>
        </div>
      </section>

      <section class="tile">
        <header class="tile-head">
          <span class="tile-icon">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3" />
            </svg>
          </span>
          <span class="tile-title">检索测试</span>
        </header>

        <form class="row" @submit.prevent="runTest">
          <input v-model="testQuery" class="field" placeholder="输入一句话，看看会想起哪些记忆" />
          <button class="reset-button" type="submit" :disabled="testing || !testQuery.trim()">{{ testing ? '检索中…' : '检索' }}</button>
        </form>
        <span v-if="testError" class="setting-desc warn">{{ testError }}</span>
        <template v-else-if="testResult">
          <span class="setting-desc">
            {{ testResult.semantic ? '语义 + 关键词匹配' : '仅关键词匹配' }}，召回 {{ testResult.memories.length }} 条
          </span>
          <ol class="results">
            <li v-for="memory in testResult.memories" :key="memory.id" class="result">
              <span class="chip">{{ categoryLabel(memory.category) }}</span>
              <span class="result-content">{{ memory.content }}</span>
              <span class="scores">
                <template v-if="memory.core">核心档案</template>
                <template v-else>
                  得分 {{ memory.score.toFixed(2) }} · 相关 {{ memory.relevance.toFixed(2) }} · 重要 {{ memory.importance.toFixed(2) }} · 新近 {{ memory.recency.toFixed(2) }}
                </template>
              </span>
            </li>
          </ol>
        </template>
      </section>

      <MemoryLibrary />
      <MemoryMaintenance />
      <MemoryHistory />
    </template>
  </div>
</template>

<style scoped src="../../css/settings/SceneSetting.css"></style>
<style scoped src="../../css/settings/MemorySetting.css"></style>
