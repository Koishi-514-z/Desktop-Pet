<script setup lang="ts">
import { ref } from 'vue'

/**
 * 快捷键录制按钮：点击后按下组合键即可设置（Esc 取消），与默认值不同时旁边显示「恢复默认」。
 * 快捷键格式如 Ctrl+Alt+KeyQ（修饰键 + KeyboardEvent.code），与 Rust 端注册全局快捷键的格式一致
 */
const props = defineProps<{
  defaultValue: string
  disabled?: boolean
}>()

const shortcut = defineModel<string>({ required: true })

const emit = defineEmits<{
  // 录制时的提示（如缺少修饰键），为空字符串表示清除提示
  hint: [message: string]
}>()

const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight'])

const recording = ref(false)

// Ctrl+Alt+KeyQ → Ctrl + Alt + Q
function formatShortcut(value: string) {
  return value
    .split('+')
    .map((part) => part.replace(/^Key(?=[A-Z]$)/, '').replace(/^Digit(?=\d$)/, ''))
    .join(' + ')
}

function stopRecording(event: Event) {
  recording.value = false
  ;(event.target as HTMLElement).blur()
}

function onKeydown(event: KeyboardEvent) {
  if (!recording.value) return
  event.preventDefault()
  if (event.key === 'Escape') {
    emit('hint', '')
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
    emit('hint', '需要至少一个修饰键（Ctrl / Alt / Shift）')
    return
  }

  emit('hint', '')
  shortcut.value = [...modifiers, event.code].join('+')
  stopRecording(event)
}

function reset() {
  emit('hint', '')
  shortcut.value = props.defaultValue
}
</script>

<template>
  <div class="shortcut-row">
    <button
      type="button"
      class="shortcut-recorder"
      :class="{ recording }"
      :disabled="disabled"
      @click="recording = true"
      @blur="recording = false"
      @keydown="onKeydown"
    >
      {{ recording ? '请按下组合键…' : formatShortcut(shortcut) }}
    </button>
    <button v-if="shortcut !== defaultValue" class="reset-button" type="button" @click="reset">
      恢复默认
    </button>
  </div>
</template>

<style scoped>
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
}

/* 与设置页中其他「恢复默认」按钮相同（父组件的 scoped 样式作用不到子组件内部） */
.reset-button {
  margin-left: auto;
  padding: 4px 10px;
  font: inherit;
  font-size: 11px;
  color: rgb(255 255 255 / 55%);
  cursor: pointer;
  background: transparent;
  border: 1px solid rgb(255 255 255 / 12%);
  border-radius: 999px;
  transition:
    color 0.2s,
    border-color 0.2s;
}

.reset-button:hover {
  color: var(--mint);
  border-color: var(--mint);
}
</style>
