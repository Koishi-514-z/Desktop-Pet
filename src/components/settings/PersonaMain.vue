<script setup lang="ts">
import { usePersonaStore } from '@/stores/persona'

const emit = defineEmits<{
  select: [id: string]
  add: []
}>()

const personaStore = usePersonaStore()
</script>

<template>
  <div class="persona-setting">
    <div class="persona-cards">
      <div
        v-for="persona in personaStore.personas"
        :key="persona.id"
        class="persona-card"
        :class="{ current: personaStore.currentPersonaId === persona.id }"
        @click="emit('select', persona.id)"
      >
        <div class="card-header">
          <span class="card-name">{{ persona.name }}</span>
        </div>
        <p class="card-description">
          {{ persona.personality || '暂无性格描述' }}
        </p>
        <div class="card-actions">
          <button
            class="card-action"
            :class="{ active: personaStore.currentPersonaId === persona.id }"
            @click.stop="personaStore.switchPersona(persona.id)"
          >
            {{ personaStore.currentPersonaId === persona.id ? '使用中' : '设为当前' }}
          </button>
          <button
            class="card-remove"
            title="删除"
            :disabled="personaStore.isDefaultPersona(persona.id)"
            @click.stop="personaStore.removePersona(persona.id)"
          >
            ×
          </button>
        </div>
      </div>

      <div class="persona-card add-card" @click="emit('add')">
        <span class="add-icon">+</span>
        <span>添加人设</span>
      </div>
    </div>
  </div>
</template>

<style scoped src="../../css/settings/PersonaSetting.css"></style>
