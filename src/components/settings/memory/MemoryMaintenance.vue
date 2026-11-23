<script setup lang="ts">
import type { ListedMemory } from '@/memory/types'
import { ref } from 'vue'
import { formatDate } from '@/agent/utils'
import { previewForgetting } from '@/memory/api'
import { categoryLabel } from '@/memory/types'
import { useMemoryStore } from '@/stores/memory'

const memoryStore = useMemoryStore()

const error = ref('')
const preview = ref<ListedMemory[] | null>(null)
const undoneBatches = ref(new Set<string>())

function formatTime(timestamp: number) {
  if (!timestamp) return '还没有进行过'
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `上次：${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function run(action: () => Promise<unknown>) {
  error.value = ''
  try {
    await action()
  }
  catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

function consolidate() {
  run(() => memoryStore.consolidate())
}

function loadPreview() {
  run(async () => {
    preview.value = await previewForgetting()
  })
}

function forget() {
  run(async () => {
    await memoryStore.forget()
    preview.value = null
  })
}

function undo(batch: string) {
  run(async () => {
    await memoryStore.undo({ batchId: batch })
    undoneBatches.value = new Set([...undoneBatches.value, batch])
  })
}
</script>

<template>
  <section class="tile">
    <header class="tile-head">
      <span class="tile-icon">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 7h16M4 12h10M4 17h6M17 14l3 3-3 3" />
        </svg>
      </span>
      <span class="tile-title">整理与遗忘</span>
    </header>

    <label class="toggle-setting">
      <span class="setting-label">
        <span>自动整理</span>
        <span class="setting-desc">记忆有较多变化时（每天最多一次），由对话模型合并重复与矛盾的记忆、把多次出现的情景归纳为习惯、改写含糊的表述、归档已失效的记忆。固定的记忆不会被整理</span>
      </span>
      <span class="switch">
        <input v-model="memoryStore.autoConsolidate" type="checkbox" />
        <span class="switch-track" />
      </span>
    </label>
    <div class="row">
      <span class="setting-desc">{{ formatTime(memoryStore.lastConsolidatedAt) }}</span>
      <span class="spacer" />
      <button class="small-button" type="button" :disabled="!!memoryStore.maintaining" @click="consolidate">
        {{ memoryStore.maintaining?.kind === 'consolidate'
          ? `整理中（${memoryStore.maintaining.done}/${memoryStore.maintaining.total || '?'} 组）…`
          : '立即整理' }}
      </button>
    </div>
    <div v-if="memoryStore.lastConsolidation" class="row summary">
      <span>
        整理了 {{ memoryStore.lastConsolidation.groups }} 组记忆：合并 {{ memoryStore.lastConsolidation.merged }} 次，改写 {{ memoryStore.lastConsolidation.updated }} 条，归档 {{ memoryStore.lastConsolidation.archived }} 条
      </span>
      <span class="spacer" />
      <button
        v-if="memoryStore.lastConsolidation.merged + memoryStore.lastConsolidation.updated + memoryStore.lastConsolidation.archived > 0"
        class="small-button"
        type="button"
        :disabled="undoneBatches.has(memoryStore.lastConsolidation.batch)"
        @click="undo(memoryStore.lastConsolidation.batch)"
      >
        {{ undoneBatches.has(memoryStore.lastConsolidation.batch) ? '已撤销' : '撤销这次整理' }}
      </button>
    </div>

    <label class="toggle-setting">
      <span class="setting-label">
        <span>自动遗忘</span>
        <span class="setting-desc">按遗忘曲线计算记忆强度：越重要、越常被想起的记忆忘得越慢，每次被想起都会重新巩固。每天检查一次，把强度过低、又不太重要（重要程度低于 0.6）的记忆归档。核心档案、固定的记忆与 7 天内的新记忆不会被遗忘</span>
      </span>
      <span class="switch">
        <input v-model="memoryStore.autoForget" type="checkbox" />
        <span class="switch-track" />
      </span>
    </label>
    <div class="row">
      <span class="setting-desc">{{ formatTime(memoryStore.lastForgotAt) }}</span>
      <span class="spacer" />
      <button class="small-button" type="button" :disabled="!!memoryStore.maintaining" @click="loadPreview">预览</button>
      <button class="small-button" type="button" :disabled="!!memoryStore.maintaining" @click="forget">
        {{ memoryStore.maintaining?.kind === 'forget' ? '遗忘中…' : '立即遗忘' }}
      </button>
    </div>
    <template v-if="preview">
      <span class="setting-desc">{{ preview.length ? `现在会遗忘这 ${preview.length} 条记忆：` : '现在没有需要遗忘的记忆' }}</span>
      <ul v-if="preview.length" class="memories">
        <li v-for="memory in preview" :key="memory.id" class="memory">
          <span class="chip">{{ categoryLabel(memory.category) }}</span>
          <span class="memory-text">
            <span>{{ memory.content }}</span>
            <span class="memory-meta">重要 {{ memory.importance.toFixed(1) }} · 记忆强度 {{ Math.round(memory.retention * 100) }}% · {{ formatDate(new Date(memory.updatedAt)) }}</span>
          </span>
        </li>
      </ul>
    </template>
    <div v-if="memoryStore.lastForgetting" class="row summary">
      <span>上次遗忘了 {{ memoryStore.lastForgetting.memories.length }} 条记忆（可以在「已归档」中恢复）</span>
      <span class="spacer" />
      <button
        v-if="memoryStore.lastForgetting.memories.length > 0"
        class="small-button"
        type="button"
        :disabled="undoneBatches.has(memoryStore.lastForgetting.batch)"
        @click="undo(memoryStore.lastForgetting.batch)"
      >
        {{ undoneBatches.has(memoryStore.lastForgetting.batch) ? '已撤销' : '撤销这次遗忘' }}
      </button>
    </div>

    <span v-if="error || memoryStore.maintenanceError" class="setting-desc warn">{{ error || memoryStore.maintenanceError }}</span>
  </section>
</template>

<style scoped src="../../../css/settings/SceneSetting.css"></style>
<style scoped src="../../../css/settings/MemorySetting.css"></style>
<style scoped>
.spacer {
  flex: 1;
}
</style>
