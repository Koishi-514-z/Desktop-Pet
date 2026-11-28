<script lang="ts">
/**
 * 给表情或动作打情绪标签：每行一项，显示当前的标签，点「编辑」展开分组的标签供勾选。
 * 修改立即通过 update 事件交给上层保存；tags 为 null 表示恢复为模型文件中的标签
 */
export interface TagEditorItem {
  key: string
  label: string
  /** 鼠标停留时的说明，如文件名 */
  title?: string
  tags: string[]
  /** 在设置中改过（优先于模型文件中的标签） */
  custom: boolean
}
</script>

<script setup lang="ts">
import { ref } from 'vue'
import { LIVE2D_TAG_GROUPS, tagLabel, tagTitle } from '@/live2d/tags'

defineProps<{
  items: TagEditorItem[]
  /** 是否显示预览按钮（点击后在桌面上播放） */
  playable?: boolean
}>()

const emit = defineEmits<{
  update: [key: string, tags: string[] | null]
  play: [key: string]
}>()

const KNOWN_TAGS = new Set(LIVE2D_TAG_GROUPS.flatMap((group) => group.tags.map((tag) => tag.tag)))

const expanded = ref<string | null>(null)

function toggleExpanded(key: string) {
  expanded.value = expanded.value === key ? null : key
}

function toggleTag(item: TagEditorItem, tag: string) {
  const tags = item.tags.includes(tag) ? item.tags.filter((t) => t !== tag) : [...item.tags, tag]
  emit('update', item.key, tags)
}

// 模型文件中不在标签表里的标签（如以前的 love、smug），可以取消
function unknownTags(item: TagEditorItem) {
  return item.tags.filter((tag) => !KNOWN_TAGS.has(tag))
}
</script>

<template>
  <ul class="tag-rows">
    <li v-for="item in items" :key="item.key" class="tag-row" :class="{ open: expanded === item.key }">
      <div class="row-main">
        <button v-if="playable" type="button" class="row-play" title="在桌面上预览" @click="emit('play', item.key)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12-7.5z" /></svg>
        </button>
        <span class="row-label" :title="item.title">{{ item.label }}</span>
        <span class="row-tags">
          <span v-for="tag in item.tags" :key="tag" class="chip" :title="tagTitle(tag)">{{ tagLabel(tag) }}</span>
          <span v-if="item.tags.length === 0" class="row-empty">未打标签</span>
        </span>
        <span v-if="item.custom" class="row-source" title="在设置中改过，优先于模型文件中的标签">已修改</span>
        <button type="button" class="row-edit" :aria-expanded="expanded === item.key" @click="toggleExpanded(item.key)">
          {{ expanded === item.key ? '收起' : '编辑' }}
        </button>
      </div>

      <div v-if="expanded === item.key" class="picker">
        <div v-for="group in LIVE2D_TAG_GROUPS" :key="group.title" class="picker-group">
          <span class="picker-title">{{ group.title }}</span>
          <div class="picker-chips">
            <button
              v-for="option in group.tags"
              :key="option.tag"
              type="button"
              class="chip selectable"
              :class="{ selected: item.tags.includes(option.tag) }"
              :title="tagTitle(option.tag)"
              @click="toggleTag(item, option.tag)"
            >
              {{ tagLabel(option.tag) }}
            </button>
          </div>
        </div>
        <div v-if="unknownTags(item).length" class="picker-group">
          <span class="picker-title">模型文件中的其他标签（点击取消）</span>
          <div class="picker-chips">
            <button
              v-for="tag in unknownTags(item)"
              :key="tag"
              type="button"
              class="chip selectable selected"
              @click="toggleTag(item, tag)"
            >
              {{ tag }}
            </button>
          </div>
        </div>
        <div class="picker-actions">
          <button v-if="item.tags.length" type="button" class="picker-button" @click="emit('update', item.key, [])">清空</button>
          <button v-if="item.custom" type="button" class="picker-button" @click="emit('update', item.key, null)">
            恢复为模型文件中的标签
          </button>
        </div>
      </div>
    </li>
  </ul>
</template>

<style scoped>
.tag-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.tag-row {
  background: rgb(255 255 255 / 4%);
  border: 1px solid transparent;
  border-radius: 9px;
}

.tag-row.open {
  border-color: rgb(155 123 255 / 35%);
}

.row-main {
  display: flex;
  gap: 8px;
  align-items: center;
  min-height: 34px;
  padding: 4px 8px;
}

.row-play {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  color: rgb(255 255 255 / 70%);
  cursor: pointer;
  background: rgb(255 255 255 / 8%);
  border: none;
  border-radius: 50%;
}

.row-play:hover {
  color: #fff;
  background: var(--accent, #9b7bff);
}

.row-play svg {
  width: 10px;
  height: 10px;
  fill: currentcolor;
}

.row-label {
  flex-shrink: 0;
  max-width: 40%;
  overflow: hidden;
  font-size: 12px;
  color: rgb(255 255 255 / 85%);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-tags {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
}

.row-empty {
  font-size: 11px;
  color: rgb(255 255 255 / 30%);
}

.row-source {
  flex-shrink: 0;
  padding: 1px 6px;
  font-size: 10px;
  color: var(--accent, #9b7bff);
  border: 1px solid rgb(155 123 255 / 40%);
  border-radius: 999px;
}

.row-edit {
  flex-shrink: 0;
  padding: 3px 9px;
  font: inherit;
  font-size: 11px;
  color: rgb(255 255 255 / 65%);
  cursor: pointer;
  background: transparent;
  border: 1px solid rgb(255 255 255 / 12%);
  border-radius: 999px;
}

.row-edit:hover {
  color: #fff;
  border-color: var(--accent, #9b7bff);
}

.chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  font: inherit;
  font-size: 11px;
  color: rgb(255 255 255 / 85%);
  background: rgb(155 123 255 / 18%);
  border: 1px solid transparent;
  border-radius: 6px;
}

.chip.selectable {
  color: rgb(255 255 255 / 70%);
  cursor: pointer;
  background: rgb(255 255 255 / 6%);
  transition:
    background 0.15s,
    border-color 0.15s;
}

.chip.selectable:hover {
  background: rgb(255 255 255 / 12%);
}

.chip.selectable.selected {
  color: #fff;
  background: rgb(155 123 255 / 25%);
  border-color: var(--accent, #9b7bff);
}

.picker {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 10px 10px;
  border-top: 1px solid rgb(255 255 255 / 6%);
}

.picker-group {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-top: 6px;
}

.picker-title {
  font-size: 11px;
  color: rgb(255 255 255 / 45%);
}

.picker-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.picker-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.picker-actions:empty {
  display: none;
}

.picker-button {
  padding: 4px 10px;
  font: inherit;
  font-size: 11px;
  color: rgb(255 255 255 / 65%);
  cursor: pointer;
  background: transparent;
  border: 1px solid rgb(255 255 255 / 12%);
  border-radius: 999px;
}

.picker-button:hover {
  color: #fff;
  border-color: var(--accent, #9b7bff);
}
</style>
