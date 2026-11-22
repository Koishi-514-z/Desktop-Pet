<script setup lang="ts">
import type { Persona } from '@/stores/persona'
import { usePersonaStore } from '@/stores/persona'
import { getInitial, hashHue } from '@/utils/avatar'

const emit = defineEmits<{
  select: [id: string]
  add: []
}>()

const personaStore = usePersonaStore()

function isCurrent(id: string) {
  return personaStore.currentPersonaId === id
}

function avatarStyle(persona: Persona) {
  const hue = hashHue(persona.name || 'persona')
  return {
    background: `linear-gradient(135deg, hsl(${hue} 80% 68%), hsl(${(hue + 35) % 360} 85% 58%))`,
  }
}
</script>

<template>
  <div class="persona-setting">
    <div class="persona-intro">
      <h3 class="intro-title">角色</h3>
      <p class="intro-desc">选择桌宠扮演的角色，人设会写入对话的系统提示词</p>
    </div>

    <div class="persona-list">
      <div
        v-for="persona in personaStore.personas"
        :key="persona.id"
        class="profile-row"
        :class="{ current: isCurrent(persona.id) }"
        @click="emit('select', persona.id)"
      >
        <div class="profile-avatar" :style="avatarStyle(persona)">
          {{ getInitial(persona.name) }}
        </div>

        <div class="profile-body">
          <div class="profile-name-line">
            <span class="profile-name">{{ persona.name }}</span>
            <span v-if="isCurrent(persona.id)" class="profile-current">当前角色</span>
          </div>
          <p class="profile-quote" :class="{ empty: !persona.personality }">
            {{ persona.personality || '还没有性格描述，点击完善角色档案' }}
          </p>
          <div class="profile-flags">
            <span class="flag" :class="{ filled: persona.background }">背景故事</span>
            <span class="flag" :class="{ filled: persona.speakingStyle }">说话风格</span>
          </div>
        </div>

        <div class="profile-side">
          <button
            class="pick"
            :class="{ on: isCurrent(persona.id) }"
            :title="isCurrent(persona.id) ? '当前角色' : '设为当前角色'"
            @click.stop="personaStore.switchPersona(persona.id)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />
            </svg>
          </button>
          <button
            v-if="!personaStore.isDefaultPersona(persona.id)"
            class="profile-remove"
            title="删除"
            @click.stop="personaStore.removePersona(persona.id)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
            </svg>
          </button>
        </div>
      </div>

      <button class="profile-row add-row" type="button" @click="emit('add')">
        <span class="add-avatar">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </span>
        <span class="add-text">
          <span class="add-title">创建新角色</span>
          <span class="add-desc">设定名字、性格、背景与说话风格</span>
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped src="../../css/settings/PersonaSetting.css"></style>
