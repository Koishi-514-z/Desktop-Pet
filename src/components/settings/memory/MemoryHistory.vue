<script setup lang="ts">
import type { MemoryEvent } from '@/memory/types'
import { computed, onMounted, ref, watch } from 'vue'
import { formatDate } from '@/agent/utils'
import { listMemoryEvents } from '@/memory/api'
import { categoryLabel, MEMORY_EVENT_LABELS, sourceLabel } from '@/memory/types'
import { useMemoryStore } from '@/stores/memory'

const memoryStore = useMemoryStore()

const events = ref<MemoryEvent[]>([])
const error = ref('')
const undoing = ref('')

interface EventGroup {
  key: string
  batchId: string | null
  events: MemoryEvent[]
}

// 同一批的变动（如一轮对话后的整理、一次记忆整理）显示为一组，整组撤销
const groups = computed(() => {
  const result: EventGroup[] = []
  const byKey = new Map<string, EventGroup>()
  for (const event of events.value) {
    const key = event.batchId ?? `event-${event.id}`
    let group = byKey.get(key)
    if (!group) {
      group = { key, batchId: event.batchId, events: [] }
      byKey.set(key, group)
      result.push(group)
    }
    group.events.push(event)
  }
  return result
})

function isUndone(group: EventGroup) {
  return group.events.every((event) => event.undoneAt !== null)
}

function canUndo(group: EventGroup) {
  const pending = group.events.filter((event) => event.undoneAt === null)
  return pending.length > 0 && pending.every((event) => event.undoable)
}

function formatTime(timestamp: number) {
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function load() {
  try {
    events.value = await listMemoryEvents(60)
    error.value = ''
  }
  catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function undo(group: EventGroup) {
  undoing.value = group.key
  try {
    await memoryStore.undo(group.batchId ? { batchId: group.batchId } : { eventId: group.events[0]!.id })
    error.value = ''
  }
  catch (e) {
    error.value = `撤销失败：${e instanceof Error ? e.message : String(e)}`
  }
  finally {
    undoing.value = ''
  }
}

watch(() => memoryStore.revision, load)
onMounted(load)
</script>

<template>
  <section class="tile">
    <header class="tile-head">
      <span class="tile-icon">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
          <path d="M3 3v5h5M12 7v5l3 3" />
        </svg>
      </span>
      <span class="tile-title">最近的变动</span>
    </header>

    <span class="setting-desc">同一轮对话或同一次整理产生的变动会一起撤销；之后又被修改过的记忆，需要先撤销之后的变动</span>
    <span v-if="error" class="setting-desc warn">{{ error }}</span>
    <p v-if="groups.length === 0" class="setting-desc">还没有变动记录</p>

    <ul class="memories">
      <li v-for="group in groups" :key="group.key" class="batch" :class="{ undone: isUndone(group) }">
        <div class="batch-head">
          <span>{{ formatTime(group.events[0]!.createdAt) }}</span>
          <span v-if="sourceLabel(group.events[0]!.source)">· {{ sourceLabel(group.events[0]!.source) }}</span>
          <span v-if="group.events.length > 1">· {{ group.events.length }} 项</span>
          <span class="spacer" />
          <span v-if="isUndone(group)" class="undone-badge">已撤销</span>
          <button
            v-else
            class="small-button"
            type="button"
            :disabled="!canUndo(group) || undoing !== ''"
            :title="canUndo(group) ? '撤销这次变动' : '之后又有新的变动，或较早的记录缺少撤销所需的信息'"
            @click="undo(group)"
          >
            {{ undoing === group.key ? '撤销中…' : '撤销' }}
          </button>
        </div>
        <div v-for="event in group.events" :key="event.id" class="batch-item">
          <span class="chip" :class="`action-${event.action}`">{{ MEMORY_EVENT_LABELS[event.action] }}</span>
          <span class="memory-text">
            <span>{{ event.content }}</span>
            <s v-if="event.previous" class="memory-meta">{{ event.previous }}</s>
            <span class="memory-meta">{{ categoryLabel(event.category) }}</span>
          </span>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped src="../../../css/settings/SceneSetting.css"></style>
<style scoped src="../../../css/settings/MemorySetting.css"></style>
