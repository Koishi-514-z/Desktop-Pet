<script setup lang="ts">
import type { DndOption } from '@/stores/proactive'
import type { Frequency, ProactiveLogEntry, TriggerGroup, TriggerId } from '@/proactive/types'
import { computed } from 'vue'
import { isTauri } from '@/composables/desktop'
import { APP_CATEGORY_LABELS } from '@/proactive/activity'
import { formatClock, formatMinutes } from '@/proactive/triggers'
import { DND_FOREVER, FREQUENCY_PRESETS, OUTCOME_LABELS, TRIGGER_GROUP_LABELS, TRIGGERS } from '@/proactive/types'
import { useChatStore } from '@/stores/chat'
import { useProactiveStore } from '@/stores/proactive'

const proactiveStore = useProactiveStore()
const chatStore = useChatStore()
const settings = computed(() => proactiveStore.settings)

// ===== 免打扰与频率 =====

const DND_OPTIONS: { option: DndOption, label: string }[] = [
  { option: 'hour', label: '1 小时' },
  { option: 'morning', label: '到明天早上' },
  { option: 'forever', label: '一直' },
]

function formatDateTime(at: number): string {
  const date = new Date(at)
  const today = new Date(proactiveStore.clock)
  const sameDay = date.toDateString() === today.toDateString()
  return sameDay ? formatClock(at) : `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${formatClock(at)}`
}

const dndText = computed(() => {
  if (!proactiveStore.dndActive) return '没有开启'
  if (settings.value.dndUntil >= DND_FOREVER) return '已开启，直到手动关闭'
  return `已开启，到 ${formatDateTime(settings.value.dndUntil)} 为止`
})

const FREQUENCIES: Frequency[] = ['low', 'normal', 'high']

const frequencyText = computed(() => {
  const preset = FREQUENCY_PRESETS[settings.value.frequency]
  return `两次主动说话至少间隔 ${formatMinutes(preset.minIntervalMs)}，每天最多 ${preset.dailyLimit} 次。你连续不回应时，间隔会稍微拉长（最多 2 倍）`
})

// ===== 时机 =====

const GROUPS: TriggerGroup[] = ['time', 'event', 'context', 'spontaneous']
const groups = GROUPS.map((group) => ({ group, label: TRIGGER_GROUP_LABELS[group], triggers: TRIGGERS.filter((trigger) => trigger.group === group) }))

// 时机旁边的时间设置
const TIME_FIELDS: Partial<Record<TriggerId, 'lunchTime' | 'afternoonBreakTime' | 'dinnerTime' | 'lateNightTime'>> = {
  'lunch': 'lunchTime',
  'afternoon-break': 'afternoonBreakTime',
  'dinner': 'dinnerTime',
  'late-night': 'lateNightTime',
}

// 时机旁边的分钟数设置（低于下限的输入不生效）
const MINUTE_FIELDS: Partial<Record<TriggerId, { key: 'focusMinutes' | 'sedentaryMinutes', min: number }>> = {
  'long-focus': { key: 'focusMinutes', min: 10 },
  'sedentary': { key: 'sedentaryMinutes', min: 30 },
}

function minuteField(id: TriggerId) {
  return MINUTE_FIELDS[id]
}

function setMinutes(id: TriggerId, input: HTMLInputElement) {
  const field = MINUTE_FIELDS[id]
  if (!field) return
  const value = input.valueAsNumber
  if (Number.isFinite(value) && value >= field.min) settings.value[field.key] = Math.round(value)
  // 输入无效时显示回原来的值
  input.value = String(settings.value[field.key])
}

function tryTrigger(id: TriggerId) {
  void proactiveStore.tryNow(id)
}

const canTry = computed(() => settings.value.enabled && !proactiveStore.testing && !chatStore.isStreaming)

// ===== 感知 =====

const activityText = computed(() => {
  const activity = proactiveStore.activity
  if (!isTauri) return '在浏览器中无法感知前台应用与空闲时间，只有时间与自发的时机会触发'
  if (!activity) return '正在获取…'
  if (!activity.available) return '当前系统不支持感知前台应用与空闲时间，只有时间与自发的时机会触发'
  if (!activity.present) return `已经 ${formatMinutes(activity.idleSeconds * 1000)}没有操作电脑`
  if (!activity.app || !activity.category) return '在电脑前'
  const now = proactiveStore.clock
  const parts = [`正在${APP_CATEGORY_LABELS[activity.category]}（${activity.app}）`]
  if (activity.focus) parts.push(`连续${APP_CATEGORY_LABELS[activity.focus.category]} ${formatMinutes(Math.max(0, now - activity.focus.since))}`)
  if (activity.fullscreen) parts.push('全屏')
  return parts.join(' · ')
})

const stateText = computed(() => {
  const { spokenToday, ignoredStreak } = proactiveStore.state
  const ignored = ignoredStreak > 0 ? `，最近 ${ignoredStreak} 次没有回应` : ''
  return `今天主动说了 ${spokenToday} 次${ignored}`
})

// ===== 记录 =====

function triggerLabel(entry: ProactiveLogEntry): string {
  return TRIGGERS.find((trigger) => trigger.id === entry.trigger)?.label ?? entry.trigger
}
</script>

<template>
  <div class="scene-setting proactive-setting">
    <section class="tile">
      <header class="tile-head">
        <span class="tile-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
            <path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01" />
          </svg>
        </span>
        <span class="tile-title">主动交互</span>
      </header>

      <label class="toggle-setting">
        <span class="setting-label">
          <span>启用主动交互</span>
          <span class="setting-desc">在合适的时机主动和你说话（如问候、提醒吃饭和休息），或者做个小动作。会先在本地筛掉不该打扰的时候，再由模型判断要不要说</span>
        </span>
        <span class="switch">
          <input v-model="settings.enabled" type="checkbox" />
          <span class="switch-track" />
        </span>
      </label>

      <div class="setting" :class="{ disabled: !settings.enabled }">
        <div class="setting-label">
          <span>免打扰</span>
          <span class="setting-desc" :class="{ active: proactiveStore.dndActive }">{{ dndText }}。开启后不会主动说话或做小动作，你设定的提醒照常提醒</span>
        </div>
        <div class="fps-options">
          <button
            v-for="item in DND_OPTIONS"
            :key="item.option"
            type="button"
            class="fps-chip"
            @click="proactiveStore.setDnd(item.option)"
          >
            {{ item.label }}
          </button>
          <button v-if="proactiveStore.dndActive" type="button" class="fps-chip active" @click="proactiveStore.setDnd('off')">关闭免打扰</button>
        </div>
      </div>

      <div class="setting" :class="{ disabled: !settings.enabled }">
        <div class="setting-label">
          <span>频率</span>
          <span class="setting-desc">{{ frequencyText }}</span>
        </div>
        <div class="fps-options">
          <button
            v-for="frequency in FREQUENCIES"
            :key="frequency"
            type="button"
            class="fps-chip"
            :class="{ active: settings.frequency === frequency }"
            @click="settings.frequency = frequency"
          >
            {{ FREQUENCY_PRESETS[frequency].label }}
          </button>
        </div>
      </div>

      <div class="setting" :class="{ disabled: !settings.enabled }">
        <label class="toggle-setting">
          <span class="setting-label">
            <span>安静时段</span>
            <span class="setting-desc">这段时间内不主动说话，也不做小动作</span>
          </span>
          <span class="switch">
            <input v-model="settings.quietHours.enabled" type="checkbox" />
            <span class="switch-track" />
          </span>
        </label>
        <div v-if="settings.quietHours.enabled" class="time-range">
          <input v-model="settings.quietHours.start" class="time-field" type="time" />
          <span>到</span>
          <input v-model="settings.quietHours.end" class="time-field" type="time" />
        </div>
      </div>
    </section>

    <section class="tile" :class="{ disabled: !settings.enabled }">
      <header class="tile-head">
        <span class="tile-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
        </span>
        <span class="tile-title">时机</span>
      </header>

      <div v-for="item in groups" :key="item.group" class="trigger-group">
        <p class="group-title">{{ item.label }}</p>
        <div v-for="trigger in item.triggers" :key="trigger.id" class="trigger-row">
          <label class="toggle-setting">
            <span class="setting-label">
              <span>{{ trigger.label }}</span>
              <span class="setting-desc">{{ trigger.description }}</span>
            </span>
            <span class="switch">
              <input v-model="settings.triggers[trigger.id]" type="checkbox" />
              <span class="switch-track" />
            </span>
          </label>
          <div v-if="TIME_FIELDS[trigger.id] || minuteField(trigger.id) || trigger.kind === 'speech'" class="trigger-extra">
            <template v-if="TIME_FIELDS[trigger.id]">
              <span>时间</span>
              <input v-model="settings[TIME_FIELDS[trigger.id]!]" class="time-field" type="time" />
            </template>
            <template v-if="minuteField(trigger.id)">
              <span>连续</span>
              <input
                :value="settings[minuteField(trigger.id)!.key]"
                class="time-field minutes"
                type="number"
                :min="minuteField(trigger.id)!.min"
                step="10"
                @change="setMinutes(trigger.id, $event.target as HTMLInputElement)"
              />
              <span>分钟后提醒</span>
            </template>
            <button
              v-if="trigger.kind === 'speech'"
              type="button"
              class="try-button"
              :disabled="!canTry"
              title="跳过时机开关、安静时段与频率限制，马上走一遍判断与生成"
              @click="tryTrigger(trigger.id)"
            >
              试一下
            </button>
          </div>
        </div>
      </div>
    </section>

    <section class="tile" :class="{ disabled: !settings.enabled }">
      <header class="tile-head">
        <span class="tile-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </span>
        <span class="tile-title">感知与隐私</span>
      </header>

      <div class="setting">
        <div class="setting-label">
          <span>现在的状态</span>
          <span class="setting-desc">{{ activityText }}</span>
          <span class="setting-desc">{{ stateText }}</span>
        </div>
      </div>

      <label class="toggle-setting">
        <span class="setting-label">
          <span>全屏时不打扰</span>
          <span class="setting-desc">前台窗口全屏时（游戏、全屏视频、演示）不主动说话。任务栏设为自动隐藏时，普通的最大化窗口也可能被当成全屏</span>
        </span>
        <span class="switch">
          <input v-model="settings.respectFullscreen" type="checkbox" />
          <span class="switch-track" />
        </span>
      </label>

      <label class="toggle-setting">
        <span class="setting-label">
          <span>把窗口标题告诉模型</span>
          <span class="setting-desc">默认只告诉模型你在用什么应用、在做哪一类事。窗口标题（如文件名、网页标题）能让它说得更贴切，但可能包含隐私</span>
        </span>
        <span class="switch">
          <input v-model="settings.shareWindowTitle" type="checkbox" />
          <span class="switch-track" />
        </span>
      </label>
    </section>

    <section class="tile">
      <header class="tile-head">
        <span class="tile-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
          </svg>
        </span>
        <span class="tile-title">记录</span>
        <button v-if="proactiveStore.log.length" type="button" class="reset-button" @click="proactiveStore.clearLog()">清空</button>
      </header>
      <p v-if="!proactiveStore.log.length" class="setting-desc">还没有记录。每次时机到了，这里会记下说了什么，或者为什么没说</p>
      <ul v-else class="log-list">
        <li v-for="(entry, index) in proactiveStore.log" :key="index" class="log-entry" :class="entry.outcome">
          <div class="log-head">
            <span class="log-time">{{ formatDateTime(entry.at) }}</span>
            <span class="log-trigger">{{ triggerLabel(entry) }}</span>
            <span class="log-outcome">{{ OUTCOME_LABELS[entry.outcome] }}</span>
          </div>
          <p v-if="entry.text" class="log-text">「{{ entry.text }}」</p>
          <p v-if="entry.reason" class="log-reason">{{ entry.reason }}</p>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped src="../../css/settings/SceneSetting.css"></style>
<style scoped>
.tile.disabled .toggle-setting,
.tile.disabled .setting,
.tile.disabled .trigger-extra,
.setting.disabled {
  opacity: 0.55;
}

.setting-desc.active {
  color: var(--mint);
}

.time-range,
.trigger-extra {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  font-size: 12px;
  color: rgb(255 255 255 / 55%);
}

.time-field {
  padding: 5px 8px;
  font: inherit;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: #fff;
  color-scheme: dark;
  background: rgb(0 0 0 / 28%);
  border: 1px solid rgb(255 255 255 / 12%);
  border-radius: 8px;
  outline: none;
  transition: border-color 0.2s;
}

.time-field:focus {
  border-color: var(--mint);
}

.time-field.minutes {
  width: 64px;
}

.trigger-group {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.group-title {
  margin: 0;
  font-size: 11px;
  font-weight: 700;
  color: var(--mint);
  letter-spacing: 0.08em;
}

.trigger-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.try-button {
  margin-left: auto;
  padding: 4px 10px;
  font: inherit;
  font-size: 11px;
  color: rgb(255 255 255 / 70%);
  cursor: pointer;
  background: transparent;
  border: 1px solid rgb(255 255 255 / 15%);
  border-radius: 999px;
  transition:
    color 0.2s,
    border-color 0.2s;
}

.try-button:hover:not(:disabled) {
  color: var(--mint);
  border-color: var(--mint);
}

.try-button:disabled {
  cursor: default;
  opacity: 0.5;
}

/* 主动交互的记录 */
.log-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 320px;
  padding: 0;
  margin: 0;
  overflow-y: auto;
  list-style: none;
}

.log-entry {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 7px 10px;
  font-size: 12px;
  background: rgb(0 0 0 / 18%);
  border-left: 3px solid rgb(255 255 255 / 15%);
  border-radius: 8px;
}

.log-entry.spoke {
  border-left-color: var(--mint);
}

.log-entry.declined {
  border-left-color: #fbbf24;
}

.log-entry.animated {
  border-left-color: var(--sky);
}

.log-entry.failed {
  border-left-color: #f87171;
}

.log-head {
  display: flex;
  gap: 8px;
  align-items: baseline;
}

.log-time {
  font-variant-numeric: tabular-nums;
  color: rgb(255 255 255 / 40%);
}

.log-trigger {
  font-weight: 600;
}

.log-outcome {
  margin-left: auto;
  font-size: 11px;
  color: rgb(255 255 255 / 55%);
}

.log-text,
.log-reason {
  margin: 0;
  line-height: 1.5;
  word-break: break-word;
}

.log-text {
  color: rgb(255 255 255 / 85%);
}

.log-reason {
  color: rgb(255 255 255 / 50%);
}

.log-list::-webkit-scrollbar {
  width: 6px;
}

.log-list::-webkit-scrollbar-thumb {
  background: rgb(255 255 255 / 14%);
  border-radius: 3px;
}
</style>
