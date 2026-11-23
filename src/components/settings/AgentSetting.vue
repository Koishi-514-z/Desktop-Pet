<script setup lang="ts">
import type { CaptureKind } from '@/stores/capture'
import { computed, ref } from 'vue'
import { formatDateTime } from '@/agent/utils'
import { isTauri } from '@/composables/desktop'
import { useAgentStore } from '@/stores/agent'
import { DEFAULT_SHORTCUTS, useCaptureStore } from '@/stores/capture'
import { useProvidersStore } from '@/stores/providers'
import { useRemindersStore } from '@/stores/reminders'

const agentStore = useAgentStore()
const captureStore = useCaptureStore()
const providersStore = useProvidersStore()
const remindersStore = useRemindersStore()

// ===== 划词 / 截图快捷键 =====

const CAPTURE_ITEMS: { kind: CaptureKind, label: string, desc: string, skill: string }[] = [
  {
    kind: 'selection',
    label: '划词快捷键',
    desc: '在任意应用中选中文字后按下快捷键，鼠标旁会弹出工具栏，可以翻译、解释、总结、润色或分析代码',
    skill: '划词助手',
  },
  {
    kind: 'screenshot',
    label: '截图快捷键',
    desc: '按下后框选屏幕区域，可以解释图片、提取或翻译文字、分析报错',
    skill: '图片理解',
  },
]

const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight'])

// 正在录制的快捷键
const recording = ref<CaptureKind | null>(null)
const recordHint = ref<Partial<Record<CaptureKind, string>>>({})

// Ctrl+Alt+KeyQ → Ctrl + Alt + Q
function formatShortcut(shortcut: string) {
  return shortcut
    .split('+')
    .map((part) => part.replace(/^Key(?=[A-Z]$)/, '').replace(/^Digit(?=\d$)/, ''))
    .join(' + ')
}

// 只用 Alt 作修饰键时，松开 Alt 可能激活应用菜单栏导致复制失败
function isAltOnly(shortcut: string) {
  const parts = shortcut.split('+')
  return parts.includes('Alt') && !parts.includes('Ctrl') && !parts.includes('Super')
}

function stopRecording(event: Event) {
  recording.value = null
  ;(event.target as HTMLElement).blur()
}

function onRecordKeydown(kind: CaptureKind, event: KeyboardEvent) {
  event.preventDefault()
  if (event.key === 'Escape') {
    recordHint.value[kind] = ''
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
    recordHint.value[kind] = '需要至少一个修饰键（Ctrl / Alt / Shift）'
    return
  }

  recordHint.value[kind] = ''
  captureStore.shortcuts[kind] = [...modifiers, event.code].join('+')
  stopRecording(event)
}

// ===== 图片理解使用的模型 =====

const llmProviders = computed(() => providersStore.getLLMProviders())

const visionProviderId = computed({
  get: () => agentStore.visionModel?.providerId ?? '',
  set: (id: string) => {
    const provider = id ? providersStore.getProviderById(id) : undefined
    agentStore.visionModel = provider ? { providerId: provider.id, modelId: provider.selectedModelId } : null
  },
})

const visionModelId = computed({
  get: () => agentStore.visionModel?.modelId ?? '',
  set: (modelId: string) => {
    if (agentStore.visionModel) agentStore.visionModel = { ...agentStore.visionModel, modelId: modelId.trim() }
  },
})

const visionModels = computed(() => providersStore.getProviderById(visionProviderId.value)?.models ?? [])

// 已配置的模型对应的 provider 被删除时提示
const visionProviderMissing = computed(() => !!agentStore.visionModel && !providersStore.getProviderById(agentStore.visionModel.providerId))
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

    <section class="tile">
      <header class="tile-head">
        <span class="tile-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7V5h16v2M9 19h6M12 5v14" />
          </svg>
        </span>
        <span class="tile-title">划词与截图</span>
      </header>

      <div v-for="item in CAPTURE_ITEMS" :key="item.kind" class="setting" :class="{ disabled: !captureStore.active[item.kind] }">
        <div class="setting-label">
          <span>{{ item.label }}</span>
          <span class="setting-desc">{{ item.desc }}</span>
        </div>
        <div class="shortcut-row">
          <button
            type="button"
            class="shortcut-recorder"
            :class="{ recording: recording === item.kind }"
            :disabled="!captureStore.active[item.kind]"
            @click="recording = item.kind"
            @blur="recording = null"
            @keydown="recording === item.kind && onRecordKeydown(item.kind, $event)"
          >
            {{ recording === item.kind ? '请按下组合键…' : formatShortcut(captureStore.shortcuts[item.kind]) }}
          </button>
          <button
            v-if="captureStore.shortcuts[item.kind] !== DEFAULT_SHORTCUTS[item.kind]"
            class="reset-button"
            type="button"
            @click="captureStore.shortcuts[item.kind] = DEFAULT_SHORTCUTS[item.kind]"
          >
            恢复默认
          </button>
        </div>
        <span v-if="recordHint[item.kind]" class="setting-desc warn">{{ recordHint[item.kind] }}</span>
        <span v-else-if="!isTauri" class="setting-desc warn">需要在桌面应用中使用，浏览器中可以直接把文字或图片发给桌宠处理</span>
        <span v-else-if="!captureStore.active[item.kind]" class="setting-desc">启用 Agent 与「{{ item.skill }}」技能后生效</span>
        <span v-else-if="captureStore.shortcutErrors[item.kind]" class="setting-desc warn">{{ captureStore.shortcutErrors[item.kind] }}</span>
        <span v-else-if="item.kind === 'selection' && isAltOnly(captureStore.shortcuts[item.kind])" class="setting-desc warn">
          只用 Alt 作修饰键时，部分应用会在松开 Alt 时激活菜单栏，可能导致取词失败，建议搭配 Ctrl
        </span>
        <span v-else class="setting-desc ok">快捷键已生效</span>
      </div>
    </section>

    <section class="tile" :class="{ disabled: !agentStore.isSkillEnabled('image') }">
      <header class="tile-head">
        <span class="tile-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="3" />
            <circle cx="9" cy="10" r="2" />
            <path d="m21 16-5-5-9 9" />
          </svg>
        </span>
        <span class="tile-title">图片理解</span>
      </header>

      <div class="setting">
        <div class="setting-label">
          <span>识图模型</span>
          <span class="setting-desc">理解图片需要支持视觉输入的模型（如 GPT-4o、Claude、Gemini）。对话模型不支持图片时（如 DeepSeek），在这里单独指定一个</span>
        </div>
        <div class="model-row">
          <select v-model="visionProviderId" class="field">
            <option value="">跟随对话模型</option>
            <option v-for="provider in llmProviders" :key="provider.id" :value="provider.id">{{ provider.name }}</option>
          </select>
          <template v-if="agentStore.visionModel && !visionProviderMissing">
            <input v-model.lazy="visionModelId" class="field" list="vision-models" placeholder="模型 ID" />
            <datalist id="vision-models">
              <option v-for="model in visionModels" :key="model.id" :value="model.id">{{ model.name }}</option>
            </datalist>
          </template>
        </div>
        <span v-if="visionProviderMissing" class="setting-desc warn">之前选择的 Provider 已被删除，当前使用对话模型</span>
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
.tile.disabled .toggle-setting,
.tile.disabled .setting,
.setting.disabled {
  opacity: 0.55;
}

.tile.disabled .toggle-setting {
  cursor: default;
}

.reminder {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}

.shortcut-row,
.model-row {
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

.field {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  font: inherit;
  font-size: 13px;
  color: #fff;
  background: rgb(0 0 0 / 28%);
  border: 1px solid rgb(255 255 255 / 12%);
  border-radius: 10px;
  outline: none;
  transition: border-color 0.2s;
}

.field:focus {
  border-color: var(--mint);
}

.field option {
  color: #fff;
  background: #1e1e22;
}

.setting-desc.warn {
  color: #fbbf24;
}

.setting-desc.ok {
  color: var(--mint);
}
</style>
