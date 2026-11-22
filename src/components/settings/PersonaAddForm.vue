<script setup lang="ts">
import type { PersonaForm } from './PersonaProfileFields.vue'
import { computed, ref } from 'vue'
import { usePersonaStore } from '@/stores/persona'
import PersonaProfileFields from './PersonaProfileFields.vue'

const emit = defineEmits<{ back: []; created: [id: string] }>()

const personaStore = usePersonaStore()

const form = ref<PersonaForm>({
  name: '',
  personality: '',
  background: '',
  speakingStyle: '',
})

const canSubmit = computed(() => form.value.name.trim() !== '')

function submit() {
  if (!canSubmit.value) return

  const id = personaStore.addPersona({
    id: '',
    name: form.value.name,
    personality: form.value.personality,
    background: form.value.background,
    speakingStyle: form.value.speakingStyle,
  })
  emit('created', id)
}
</script>

<template>
  <div class="persona-detail">
    <header class="detail-header">
      <button class="back-button" title="返回" @click="emit('back')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
        角色列表
      </button>
    </header>

    <PersonaProfileFields v-model="form">
      <template #badge>
        <span class="hero-badge">✦ 新角色</span>
      </template>
    </PersonaProfileFields>

    <footer class="detail-actions">
      <span class="spacer" />
      <button class="action-button" @click="emit('back')">取消</button>
      <button class="action-button primary" :disabled="!canSubmit" @click="submit">
        创建角色
      </button>
    </footer>
  </div>
</template>

<style scoped src="../../css/settings/PersonaSetting.css"></style>
