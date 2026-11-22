<script setup lang="ts">
import { computed, ref } from 'vue'
import { formatDateTime } from '@/agent/utils'
import { isTauri } from '@/composables/desktop'
import { useAgentStore } from '@/stores/agent'
import { useRemindersStore } from '@/stores/reminders'
import { DEFAULT_SELECTION_SHORTCUT, useSelectionStore } from '@/stores/selection'

const agentStore = useAgentStore()
const remindersStore = useRemindersStore()
const selectionStore = useSelectionStore()

// ===== 划词快捷键录制 =====

const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight'])

const recording = ref(false)
const recordHint = ref('')

// Ctrl+Alt+KeyQ → Ctrl + Alt + Q
function formatShortcut(shortcut: string) {
  return shortcut
    .split('+')
    .map((part) => part.replace(/^Key(?=[A-Z]$)/, '').replace(/^Digit(?=\d$)/, ''))
    .join(' + ')
}

const shortcutLabel = computed(() => (recording.value ? '请按下组合键…' : formatShortcut(selectionStore.shortcut)))

// 只用 Alt 作修饰键时，松开 Alt 可能激活应用菜单栏导致复制失败
const altOnly = computed(() => {
  const parts = selectionStore.shortcut.split('+')
  return parts.includes('Alt') && !parts.includes('Ctrl') && !parts.includes('Super')
})

function stopRecording(event: Event) {
  recording.value = false
  ;(event.target as HTMLElement).blur()
}

function onRecordKeydown(event: KeyboardEvent) {
  event.preventDefault()
  if (event.key === 'Escape') {
    recordHint.value = ''
    stopRecording(event)
    return
  }
  if (MODIFIER_CODES.has(event.code)) return

  const modifiers: string[] = []
  if (event.ctrlKey) modifiers.push('Ctrl')
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')
  if (event.metaKey) modifiers.push('Super')
  if (modifiers.length === 0) {
    recordHint.value = '需要至少一个修饰键（Ctrl / Alt / Shift）'
    return
  }

  recordHint.value = ''
  selectionStore.shortcut = [...modifiers, event.code].join('+')
  stopRecording(event)
}
</script>

<template>
  <div class="scene-setting">
    <section class="tile">
      <header class="tile-head">
        <span class="tile-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
          </svg>
        </span>
        <span class="tile-title">Agent</span>
      </header>

      <label class="toggle-setting">
        <span class="setting-label">
          <span>启用技能</span>
          <span class="setting-desc">每条消息会先识别意图，需要时调用技能完成请求，再以角色口吻回复。关闭后直接闲聊，回复更快</span>
        </span>
        <span class="switch">
          <input v-model="agentStore.enabled" type="checkbox" />
          <span class="switch-track" />
        </span>
      </label>
    </section>

    <section class="tile" :class="{ disabled: !agentStore.enabled }">
      <header class="tile-head">
        <span class="tile-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="3" width="7" height="7" rx="1.5" />
            <rect x="14" y="3" width="7" height="7" rx="1.5" />
            <rect x="3" y="14" width="7" height="7" rx="1.5" />
            <rect x="14" y="14" width="7" height="7" rx="1.5" />
          </svg>
        </span>
        <span class="tile-title">技能</span>
      </header>

      <label v-for="skill in agentStore.skills" :key="skill.id" class="toggle-setting">
        <span class="setting-label">
          <span>{{ skill.name }}</span>
          <span class="setting-desc">{{ skill.description }}</span>
        </span>
        <span class="switch">
          <input
            type="checkbox"
            :checked="agentStore.isSkillEnabled(skill.id)"
            :disabled="!agentStore.enabled"
            @change="agentStore.setSkillEnabled(skill.id, ($event.target as HTMLInputElement).checked)"
          />
          <span class="switch-track" />
        </span>
      </label>
    </section>

    <section class="tile" :class="{ disabled: !selectionStore.active }">
      <header class="tile-head">
        <span class="tile-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7V5h16v2M9 19h6M12 5v14" />
          </svg>
        </span>
        <span class="tile-title">划词</span>
      </header>

      <div class="setting">
        <div class="setting-label">
          <span>划词快捷键</span>
          <span class="setting-desc">在任意应用中选中文字后按下快捷键，鼠标旁会弹出工具栏，可以翻译、解释、总结、润色或分析代码</span>
        </div>
        <div class="shortcut-row">
          <button
            type="button"
            class="shortcut-recorder"
            :class="{ recording }"
            :disabled="!selectionStore.active"
            @click="recording = true"
            @blur="recording = false"
            @keydown="recording && onRecordKeydown($event)"
          >
            {{ shortcutLabel }}
          </button>
          <button
            v-if="selectionStore.shortcut !== DEFAULT_SELECTION_SHORTCUT"
            class="reset-button"
            type="button"
            @click="selectionStore.shortcut = DEFAULT_SELECTION_SHORTCUT"
          >
            恢复默认
          </button>
        </div>
        <span v-if="recordHint" class="setting-desc warn">{{ recordHint }}</span>
        <span v-else-if="!isTauri" class="setting-desc warn">划词需要在桌面应用中使用，浏览器中可以直接把文字发给桌宠处理</span>
        <span v-else-if="!selectionStore.active" class="setting-desc">启用 Agent 与「划词助手」技能后生效</span>
        <span v-else-if="selectionStore.shortcutError" class="setting-desc warn">{{ selectionStore.shortcutError }}</span>
        <span v-else-if="altOnly" class="setting-desc warn">只用 Alt 作修饰键时，部分应用会在松开 Alt 时激活菜单栏，可能导致取词失败，建议搭配 Ctrl</span>
        <span v-else class="setting-desc ok">快捷键已生效</span>
      </div>
    </section>

    <section class="tile">
      <header class="tile-head">
        <span class="tile-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="13" r="8" />
            <path d="M12 9v4l2 2M5 3 2 6M19 3l3 3" />
          </svg>
        </span>
        <span class="tile-title">待触发的提醒</span>
      </header>

      <p v-if="remindersStore.reminders.length === 0" class="setting-desc">
        还没有提醒，可以在对话中说「十分钟后提醒我喝水」
      </p>
      <div v-for="reminder in remindersStore.reminders" :key="reminder.id" class="reminder">
        <span class="setting-label">
          <span>{{ reminder.message }}</span>
          <span class="setting-desc">{{ formatDateTime(new Date(reminder.dueAt)) }}</span>
        </span>
        <button class="reset-button" type="button" @click="remindersStore.cancelReminder(reminder.id)">
          取消
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped src="../../css/settings/SceneSetting.css"></style>
<style scoped>
.tile.disabled .toggle-setting {
  cursor: default;
  opacity: 0.45;
}

.reminder {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}

.shortcut-row {
  display: flex;
  gap: 10px;
  align-items: center;
}

.shortcut-recorder {
  min-width: 160px;
  padding: 8px 14px;
  font: inherit;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 13px;
  font-weight: 600;
  color: #fff;
  cursor: pointer;
  background: rgb(0 0 0 / 28%);
  border: 1px solid rgb(255 255 255 / 12%);
  border-radius: 10px;
  outline: none;
  transition:
    border-color 0.2s,
    box-shadow 0.2s;
}

.shortcut-recorder:hover:not(:disabled) {
  border-color: rgb(52 211 153 / 50%);
}

.shortcut-recorder.recording {
  color: var(--mint);
  border-color: var(--mint);
  box-shadow: 0 0 0 3px rgb(52 211 153 / 20%);
}

.shortcut-recorder:disabled {
  cursor: default;
  opacity: 0.45;
}

.setting-desc.warn {
  color: #fbbf24;
}

.setting-desc.ok {
  color: var(--mint);
}
</style>
