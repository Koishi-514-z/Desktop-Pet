<script setup lang="ts">
import type { Favorite } from '@/utils/favorites'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { FAVORITE_SORTS, useFavoritesStore } from '@/stores/favorites'
import { formatDuration } from '@/utils/audios'
import { formatSize } from '@/files/api'

const favoritesStore = useFavoritesStore()

const loadError = ref('')
onMounted(() => {
  favoritesStore.load().catch((error) => {
    loadError.value = `读取收藏失败：${error instanceof Error ? error.message : String(error)}`
  })
})

// ===== 搜索与排列 =====

const query = ref('')

const visibleItems = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  if (!keyword) return favoritesStore.sorted
  return favoritesStore.sorted.filter((item) => `${item.text} ${item.personaName}`.toLowerCase().includes(keyword))
})

const totalDuration = computed(() => favoritesStore.items.reduce((sum, item) => sum + item.duration, 0))

// 只有按自定义顺序排列、没有在搜索时才能调整顺序
const canReorder = computed(() => favoritesStore.sort === 'custom' && !query.value.trim())

function moveBy(item: Favorite, step: number) {
  const index = favoritesStore.sorted.findIndex((favorite) => favorite.id === item.id)
  favoritesStore.move(item.id, index + step)
}

// 拖动调整顺序：拖到一行的上半部分时放在它前面，下半部分时放在它后面
const draggingId = ref<string | null>(null)
const dropIndex = ref<number | null>(null)

function onDragStart(event: DragEvent, item: Favorite) {
  if (!canReorder.value) return
  draggingId.value = item.id
  event.dataTransfer?.setData('text/plain', item.text)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onDragOver(event: DragEvent, index: number) {
  if (!draggingId.value) return
  event.preventDefault()
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  dropIndex.value = event.clientY < rect.top + rect.height / 2 ? index : index + 1
}

function onDrop(event: DragEvent) {
  event.preventDefault()
  const id = draggingId.value
  const target = dropIndex.value
  if (id && target !== null) {
    const from = favoritesStore.sorted.findIndex((item) => item.id === id)
    favoritesStore.move(id, from < target ? target - 1 : target)
  }
  onDragEnd()
}

function onDragEnd() {
  draggingId.value = null
  dropIndex.value = null
}

// ===== 重听 =====

const playError = ref('')
let playErrorTimer: ReturnType<typeof setTimeout> | undefined

async function togglePlay(item: Favorite) {
  playError.value = ''
  if (favoritesStore.playingId === item.id) {
    favoritesStore.stop()
    return
  }
  try {
    await favoritesStore.play(item.id)
  }
  catch (error) {
    playError.value = error instanceof Error ? error.message : String(error)
    clearTimeout(playErrorTimer)
    playErrorTimer = setTimeout(() => (playError.value = ''), 5000)
  }
}

// ===== 展开全文、复制、删除 =====

const expanded = ref(new Set<string>())

function toggleExpanded(id: string) {
  const next = new Set(expanded.value)
  if (!next.delete(id)) next.add(id)
  expanded.value = next
}

const copiedId = ref<string | null>(null)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

async function copyText(item: Favorite) {
  try {
    await navigator.clipboard.writeText(item.text)
    copiedId.value = item.id
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copiedId.value = null), 1500)
  }
  catch {
    playError.value = '复制失败'
  }
}

// 删除需要再点一次确认
const confirmingId = ref<string | null>(null)
const confirmingClear = ref(false)

async function removeItem(item: Favorite) {
  if (confirmingId.value !== item.id) {
    confirmingId.value = item.id
    return
  }
  confirmingId.value = null
  await favoritesStore.remove([item.id])
}

async function clearAll() {
  if (!confirmingClear.value) {
    confirmingClear.value = true
    return
  }
  confirmingClear.value = false
  await favoritesStore.remove(favoritesStore.items.map((item) => item.id))
}

onBeforeUnmount(() => {
  clearTimeout(playErrorTimer)
  clearTimeout(copiedTimer)
})

/** 收藏的时间：今年的不写年份 */
function formatTime(time: number): string {
  const date = new Date(time)
  const sameYear = date.getFullYear() === new Date().getFullYear()
  const day = `${sameYear ? '' : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日`
  return `${day} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
</script>

<template>
  <div class="scene-setting">
    <section class="overview">
      <div class="overview-text">
        <span class="overview-label">收藏的语音</span>
        <span class="overview-level">{{ favoritesStore.items.length }} 条</span>
        <span class="overview-hint">在字幕上点「收藏」，可以把喜欢的回复连同语音保存下来；点 ▶ 由桌宠再说一遍</span>
        <div v-if="favoritesStore.items.length" class="overview-stats">
          <span class="stat"><b>{{ formatDuration(totalDuration) }}</b>总时长</span>
          <span class="stat"><b>{{ formatSize(favoritesStore.items.reduce((sum, item) => sum + item.size, 0)) }}</b>占用空间</span>
        </div>
      </div>
    </section>

    <div v-if="favoritesStore.items.length" class="favorite-toolbar">
      <div class="fps-options sorts" role="tablist">
        <button
          v-for="item in FAVORITE_SORTS"
          :key="item.id"
          type="button"
          class="fps-chip"
          :class="{ active: favoritesStore.sort === item.id }"
          @click="favoritesStore.sort = item.id"
        >
          {{ item.label }}
        </button>
      </div>
      <input v-model="query" class="favorite-search" type="search" placeholder="搜索收藏的语句" />
    </div>

    <p v-if="loadError" class="favorite-error">{{ loadError }}</p>
    <p v-if="playError" class="favorite-error">{{ playError }}</p>

    <p v-if="favoritesStore.loaded && favoritesStore.items.length === 0" class="favorite-empty">
      还没有收藏。桌宠说话时，字幕右上角有「收藏」按钮
    </p>
    <p v-else-if="favoritesStore.items.length && visibleItems.length === 0" class="favorite-empty">没有找到包含「{{ query }}」的收藏</p>

    <ul v-if="visibleItems.length" class="favorite-list" @dragover.prevent @drop="onDrop">
      <li
        v-for="(item, index) in visibleItems"
        :key="item.id"
        class="favorite-row"
        :class="{
          playing: favoritesStore.playingId === item.id,
          dragging: draggingId === item.id,
          'drop-before': draggingId && dropIndex === index,
          'drop-after': draggingId && dropIndex === index + 1 && index === visibleItems.length - 1,
        }"
        :draggable="canReorder"
        @dragstart="onDragStart($event, item)"
        @dragover="onDragOver($event, index)"
        @dragend="onDragEnd"
      >
        <span v-if="canReorder" class="drag-handle" title="拖动调整顺序" aria-hidden="true">
          <svg viewBox="0 0 24 24"><circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" /><circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" /><circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" /></svg>
        </span>

        <button
          type="button"
          class="play-button"
          :title="favoritesStore.playingId === item.id ? '停止' : '由桌宠再说一遍'"
          :disabled="favoritesStore.petBusy && favoritesStore.playingId !== item.id"
          @click="togglePlay(item)"
        >
          <svg v-if="favoritesStore.playingId === item.id" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" /></svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" /></svg>
        </button>

        <div class="favorite-body">
          <p class="favorite-text" :class="{ expanded: expanded.has(item.id) }" :title="expanded.has(item.id) ? '收起' : '展开全文'" @click="toggleExpanded(item.id)">{{ item.text }}</p>
          <span class="favorite-meta">
            {{ item.personaName }} · {{ formatTime(item.createdAt) }} · {{ item.duration ? formatDuration(item.duration) : '时长未知' }}<template v-if="item.voice"> · {{ item.voice }}</template>
          </span>
        </div>

        <div class="favorite-actions">
          <template v-if="canReorder">
            <button type="button" class="icon-action" title="上移" :disabled="index === 0" @click="moveBy(item, -1)">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg>
            </button>
            <button type="button" class="icon-action" title="下移" :disabled="index === visibleItems.length - 1" @click="moveBy(item, 1)">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
            </button>
          </template>
          <button type="button" class="icon-action" :title="copiedId === item.id ? '已复制' : '复制文字'" @click="copyText(item)">
            <svg v-if="copiedId === item.id" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
            <svg v-else viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></svg>
          </button>
          <button
            type="button"
            class="icon-action delete"
            :class="{ confirming: confirmingId === item.id }"
            :title="confirmingId === item.id ? '再点一次删除' : '删除'"
            @click="removeItem(item)"
            @blur="confirmingId === item.id && (confirmingId = null)"
          >
            <span v-if="confirmingId === item.id">确认删除</span>
            <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>
          </button>
        </div>
      </li>
    </ul>

    <footer v-if="favoritesStore.items.length" class="favorite-footer">
      <span class="setting-desc">收藏保存在本机；删除后无法恢复（还在对话中的回复可以重新收藏，会重新合成语音）</span>
      <button type="button" class="reset-button" @click="clearAll" @blur="confirmingClear = false">
        {{ confirmingClear ? '再点一次确认清空' : '清空收藏' }}
      </button>
    </footer>
  </div>
</template>

<style scoped src="../../css/settings/SceneSetting.css"></style>
<style scoped>
.favorite-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.sorts {
  margin: 0;
}

.favorite-search {
  flex: 1;
  min-width: 140px;
  padding: 6px 10px;
  font: inherit;
  font-size: 12px;
  color: #fff;
  background: rgb(255 255 255 / 6%);
  border: 1px solid rgb(255 255 255 / 12%);
  border-radius: 8px;
  outline: none;
}

.favorite-search:focus {
  border-color: rgb(255 255 255 / 30%);
}

.favorite-empty,
.favorite-error {
  margin: 0;
  font-size: 12px;
  text-align: center;
}

.favorite-empty {
  padding: 24px 0;
  color: rgb(255 255 255 / 40%);
}

.favorite-error {
  color: #ffb3c0;
}

.favorite-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.favorite-row {
  position: relative;
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 10px 12px;
  background: rgb(255 255 255 / 4%);
  border: 1px solid rgb(255 255 255 / 8%);
  border-radius: 12px;
  transition: background 0.15s, border-color 0.15s, opacity 0.15s;
}

.favorite-row:hover {
  background: rgb(255 255 255 / 7%);
}

.favorite-row.playing {
  border-color: rgb(255 143 184 / 55%);
  box-shadow: 0 0 0 1px rgb(255 143 184 / 20%) inset;
}

.favorite-row.dragging {
  opacity: 0.4;
}

/* 拖动时的插入位置 */
.favorite-row.drop-before::before,
.favorite-row.drop-after::after {
  position: absolute;
  right: 8px;
  left: 8px;
  height: 2px;
  content: '';
  background: #ff8fb8;
  border-radius: 2px;
}

.favorite-row.drop-before::before {
  top: -5px;
}

.favorite-row.drop-after::after {
  bottom: -5px;
}

.drag-handle {
  display: flex;
  flex-shrink: 0;
  color: rgb(255 255 255 / 30%);
  cursor: grab;
}

.drag-handle svg {
  width: 14px;
  height: 14px;
  fill: currentcolor;
}

.play-button {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  color: #fff;
  cursor: pointer;
  background: linear-gradient(135deg, #ff8fb8, #a77bff);
  border: none;
  border-radius: 50%;
  box-shadow: 0 4px 12px rgb(255 143 184 / 25%);
  transition: transform 0.15s, opacity 0.15s;
}

.play-button:hover:not(:disabled) {
  transform: scale(1.06);
}

.play-button:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

.play-button svg {
  width: 14px;
  height: 14px;
  fill: currentcolor;
}

.favorite-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.favorite-text {
  display: -webkit-box;
  margin: 0;
  overflow: hidden;
  font-size: 13px;
  line-height: 1.55;
  color: rgb(255 255 255 / 90%);
  word-break: break-word;
  white-space: pre-wrap;
  cursor: pointer;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.favorite-text.expanded {
  display: block;
}

.favorite-meta {
  overflow: hidden;
  font-size: 11px;
  color: rgb(255 255 255 / 40%);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.favorite-actions {
  display: flex;
  flex-shrink: 0;
  gap: 2px;
  align-items: center;
}

.icon-action {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 26px;
  height: 26px;
  padding: 0 4px;
  font: inherit;
  font-size: 11px;
  color: rgb(255 255 255 / 55%);
  cursor: pointer;
  background: transparent;
  border: none;
  border-radius: 6px;
}

.icon-action:hover:not(:disabled) {
  color: #fff;
  background: rgb(255 255 255 / 10%);
}

.icon-action:disabled {
  cursor: default;
  opacity: 0.25;
}

.icon-action svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentcolor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.icon-action.delete:hover,
.icon-action.delete.confirming {
  color: #fff;
  background: rgb(255 77 109 / 70%);
}

.favorite-footer {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}

.favorite-footer .reset-button {
  flex-shrink: 0;
  white-space: nowrap;
}
</style>
