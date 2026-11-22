<script setup lang="ts">
import { formatDateTime } from '@/agent/utils'
import { useAgentStore } from '@/stores/agent'
import { useRemindersStore } from '@/stores/reminders'

const agentStore = useAgentStore()
const remindersStore = useRemindersStore()
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
</style>
