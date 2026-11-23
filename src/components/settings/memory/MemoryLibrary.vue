<script setup lang="ts">
import type { ListedMemory, MemoryCategory, MemoryPatch } from '@/memory/types'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { formatDate } from '@/agent/utils'
import { listMemories } from '@/memory/api'
import { parseLocalDateTime } from '@/memory/extract'
import { categoryLabel, MEMORY_CATEGORIES } from '@/memory/types'
import { useMemoryStore } from '@/stores/memory'

const memoryStore = useMemoryStore()

// 筛选：全部、某个类别，或已归档的记忆
const filter = ref<MemoryCategory | '' | 'archived'>('')
const memories = ref<ListedMemory[]>([])
const error = ref('')
const busy = ref(false)

const categoryCounts = computed(() => new Map(memoryStore.stats?.byCategory ?? []))
const showingArchived = computed(() => filter.value === 'archived')

async function load() {
  try {
    memories.value = await listMemories({
      category: filter.value && filter.value !== 'archived' ? filter.value : undefined,
      archived: showingArchived.value,
      limit: 100,
    })
    error.value = ''
  }
  catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

/** 执行一个操作，出错时显示错误 */
async function run(action: () => Promise<unknown>) {
  busy.value = true
  try {
    await action()
    error.value = ''
  }
  catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
  finally {
    busy.value = false
  }
}

// ===== 新增 =====

const draft = reactive({ category: 'profile' as MemoryCategory, content: '', importance: 0.5 })

async function addDraft() {
  const content = draft.content.trim()
  if (!content) return
  await run(async () => {
    await memoryStore.addMemory({ category: draft.category, content, importance: draft.importance, source: 'manual' })
    draft.content = ''
  })
}

// ===== 编辑 =====

const editingId = ref<number | null>(null)
const edit = reactive({ content: '', category: 'profile' as MemoryCategory, importance: 0.5, date: '', pinned: false })

const hasDate = computed(() => edit.category === 'episodic' || edit.category === 'plan')

function startEdit(memory: ListedMemory) {
  editingId.value = memory.id
  Object.assign(edit, {
    content: memory.content,
    category: memory.category,
    importance: memory.importance,
    date: memory.occurredAt ? formatDate(new Date(memory.occurredAt)) : '',
    pinned: memory.pinned,
  })
}

async function saveEdit(memory: ListedMemory) {
  const content = edit.content.trim()
  if (!content) return
  const patch: MemoryPatch = { category: edit.category, importance: edit.importance, pinned: edit.pinned }
  if (content !== memory.content) patch.content = content
  const occurredAt = hasDate.value ? parseLocalDateTime(edit.date) : undefined
  if (occurredAt !== undefined) patch.occurredAt = occurredAt
  await run(async () => {
    await memoryStore.editMemory(memory.id, patch)
    editingId.value = null
  })
}

function togglePin(memory: ListedMemory) {
  run(() => memoryStore.editMemory(memory.id, { pinned: !memory.pinned }))
}

function remove(memory: ListedMemory) {
  run(() => memoryStore.deleteMemory(memory.id))
}

function restore(memory: ListedMemory) {
  run(() => memoryStore.restoreMemories([memory.id]))
}

// ===== 展示 =====

function retentionClass(retention: number) {
  if (retention < 0.3) return 'faded'
  if (retention < 0.6) return 'low'
  return ''
}

watch(filter, () => {
  editingId.value = null
  load()
})
// 记忆库变动（对话后自动整理、手动增删、撤销）时刷新列表
watch(() => memoryStore.revision, load)
onMounted(load)
</script>

<template>
  <section class="tile">
    <header class="tile-head">
      <span class="tile-icon">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <ellipse cx="12" cy="5" rx="8" ry="3" />
          <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
        </svg>
      </span>
      <span class="tile-title">记忆库</span>
      <span class="total">共 {{ memoryStore.stats?.total ?? 0 }} 条</span>
    </header>

    <div class="chips">
      <button class="chip filter" :class="{ active: filter === '' }" type="button" @click="filter = ''">全部</button>
      <button
        v-for="category in MEMORY_CATEGORIES"
        :key="category.id"
        class="chip filter"
        :class="{ active: filter === category.id }"
        type="button"
        :title="`${category.description}（新近程度半衰期：${category.halfLife}）`"
        @click="filter = category.id"
      >
        {{ category.label }} {{ categoryCounts.get(category.id) ?? 0 }}
      </button>
      <button
        class="chip filter"
        :class="{ active: showingArchived }"
        type="button"
        title="被合并、遗忘或忘掉的记忆，可以恢复"
        @click="filter = 'archived'"
      >
        已归档 {{ memoryStore.stats?.archived ?? 0 }}
      </button>
    </div>

    <form v-if="!showingArchived" class="draft" @submit.prevent="addDraft">
      <div class="row">
        <select v-model="draft.category" class="field narrow">
          <option v-for="category in MEMORY_CATEGORIES" :key="category.id" :value="category.id">{{ category.label }}</option>
        </select>
        <input v-model="draft.content" class="field" placeholder="手动添加一条记忆，如「用户叫小明，在杭州上大学」" />
      </div>
      <div class="row">
        <span class="weight-label">重要程度</span>
        <input v-model.number="draft.importance" class="volume-slider" type="range" min="0" max="1" step="0.1" :style="{ '--fill': `${draft.importance * 100}%` }" />
        <span class="value">{{ draft.importance.toFixed(1) }}</span>
        <button class="reset-button" type="submit" :disabled="busy || !draft.content.trim()">添加</button>
      </div>
    </form>

    <span v-if="error" class="setting-desc warn">{{ error }}</span>
    <p v-if="memories.length === 0" class="setting-desc">{{ showingArchived ? '没有已归档的记忆' : '还没有记忆' }}</p>
    <ul class="memories">
      <li v-for="memory in memories" :key="memory.id" class="memory">
        <span class="chip">{{ categoryLabel(memory.category) }}</span>

        <form v-if="editingId === memory.id" class="edit-form" @submit.prevent="saveEdit(memory)">
          <textarea v-model="edit.content" class="field" rows="2" />
          <div class="row">
            <select v-model="edit.category" class="field narrow">
              <option v-for="category in MEMORY_CATEGORIES" :key="category.id" :value="category.id">{{ category.label }}</option>
            </select>
            <input v-if="hasDate" v-model="edit.date" class="field date" type="date" :title="edit.category === 'plan' ? '计划时间' : '发生时间'" />
            <label class="checkbox" title="固定的记忆不会被自动整理或遗忘">
              <input v-model="edit.pinned" type="checkbox" />
              固定
            </label>
          </div>
          <div class="row">
            <span class="weight-label">重要程度</span>
            <input v-model.number="edit.importance" class="volume-slider" type="range" min="0" max="1" step="0.1" :style="{ '--fill': `${edit.importance * 100}%` }" />
            <span class="value">{{ edit.importance.toFixed(1) }}</span>
          </div>
          <div class="edit-actions">
            <button class="small-button" type="button" @click="editingId = null">取消</button>
            <button class="small-button" type="submit" :disabled="busy || !edit.content.trim()">保存</button>
          </div>
        </form>

        <template v-else>
          <span class="memory-text">
            <span>{{ memory.content }}<span v-if="memory.pinned" class="pin-badge" title="已固定，不会被自动整理或遗忘">已固定</span></span>
            <span class="memory-meta">
              重要 {{ memory.importance.toFixed(1) }}
              · {{ formatDate(new Date(memory.occurredAt ?? memory.updatedAt)) }}
              · 想起 {{ memory.accessCount }} 次
              <template v-if="!showingArchived">
                ·
                <span class="retention" :title="`记忆强度 ${Math.round(memory.retention * 100)}%：越重要、越常被想起的记忆忘得越慢`">
                  <span class="retention-bar"><span class="retention-fill" :class="retentionClass(memory.retention)" :style="{ width: `${memory.retention * 100}%` }" /></span>
                  {{ Math.round(memory.retention * 100) }}%
                </span>
              </template>
              <template v-if="!memory.embeddingModel"> · 无向量</template>
            </span>
          </span>

          <span class="memory-actions">
            <template v-if="showingArchived">
              <button class="icon-action" type="button" title="恢复" :disabled="busy" @click="restore(memory)">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" /></svg>
              </button>
            </template>
            <template v-else>
              <button class="icon-action" type="button" title="编辑" :disabled="busy" @click="startEdit(memory)">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
              </button>
              <button
                class="icon-action"
                :class="{ active: memory.pinned }"
                type="button"
                :title="memory.pinned ? '取消固定' : '固定：不会被自动整理或遗忘'"
                :disabled="busy"
                @click="togglePin(memory)"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l-1 6 4 4H6l4-4zM12 14v7" /></svg>
              </button>
            </template>
            <button class="icon-action danger" type="button" :title="showingArchived ? '永久删除' : '删除'" :disabled="busy" @click="remove(memory)">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          </span>
        </template>
      </li>
    </ul>
  </section>
</template>

<style scoped src="../../../css/settings/SceneSetting.css"></style>
<style scoped src="../../../css/settings/MemorySetting.css"></style>
