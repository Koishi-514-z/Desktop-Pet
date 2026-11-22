<script setup lang="ts">
import type { PersonaForm } from './PersonaProfileFields.vue'
import { computed, ref, watch } from 'vue'
import { usePersonaStore } from '@/stores/persona'
import PersonaProfileFields from './PersonaProfileFields.vue'

const props = defineProps<{ personaId: string }>()
const emit = defineEmits<{ back: [] }>()

const personaStore = usePersonaStore()

const persona = computed(() => personaStore.getPersonaById(props.personaId))
const isCurrent = computed(() => personaStore.currentPersonaId === props.personaId)
const canRemove = computed(() => !personaStore.isDefaultPersona(props.personaId))
const systemPrompt = computed(() => personaStore.buildSystemPrompt(props.personaId))

const form = ref<PersonaForm>({
  name: '',
  personality: '',
  background: '',
  speakingStyle: '',
})

function resetForm() {
  const p = persona.value
  if (!p) return
  form.value = {
    name: p.name,
    personality: p.personality,
    background: p.background ?? '',
    speakingStyle: p.speakingStyle ?? '',
  }
}

watch(() => props.personaId, resetForm, { immediate: true })

const dirty = computed(() => {
  const p = persona.value
  if (!p) return false
  const f = form.value
  return (
    f.name !== p.name ||
    f.personality !== p.personality ||
    f.background !== (p.background ?? '') ||
    f.speakingStyle !== (p.speakingStyle ?? '')
  )
})

function save() {
  if (!persona.value || !dirty.value) return
  personaStore.updatePersona(persona.value.id, { ...form.value })
}

function remove() {
  if (!persona.value) return
  personaStore.removePersona(persona.value.id)
  emit('back')
}

// 系统提示词预览
const promptExpanded = ref(false)
const copied = ref(false)

async function copyPrompt() {
  try {
    await navigator.clipboard.writeText(systemPrompt.value)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch (error) {
    console.error(error)
  }
}
</script>

<template>
  <div v-if="persona" class="persona-detail">
    <header class="detail-header">
      <button class="back-button" title="返回" @click="emit('back')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
        角色列表
      </button>
    </header>

    <PersonaProfileFields v-model="form">
      <template #badge>
        <span class="hero-badge" :class="{ on: isCurrent }">
          {{ isCurrent ? '♥ 当前角色' : '未选用' }}
        </span>
      </template>
    </PersonaProfileFields>

    <!-- 系统提示词预览 -->
    <section class="prompt-box" :class="{ expanded: promptExpanded }">
      <header class="prompt-head">
        <span class="prompt-dots"><i /><i /><i /></span>
        <span class="prompt-title">system_prompt.md</span>
        <span class="prompt-meta">{{ systemPrompt.length }} 字符 · 保存后更新</span>
        <button class="prompt-action" type="button" @click="copyPrompt">
          {{ copied ? '已复制' : '复制' }}
        </button>
        <button class="prompt-action" type="button" @click="promptExpanded = !promptExpanded">
          {{ promptExpanded ? '收起' : '展开' }}
        </button>
      </header>
      <pre class="prompt-body">{{ systemPrompt }}</pre>
    </section>

    <footer class="detail-actions">
      <button class="action-button danger" :disabled="!canRemove" @click="remove">
        删除角色
      </button>
      <span class="spacer" />
      <button
        class="action-button"
        :class="{ active: isCurrent }"
        :disabled="isCurrent"
        @click="personaStore.switchPersona(persona.id)"
      >
        {{ isCurrent ? '当前角色' : '设为当前' }}
      </button>
      <button class="action-button primary" :disabled="!dirty" @click="save">
        {{ dirty ? '保存修改' : '已保存' }}
      </button>
    </footer>
  </div>
</template>

<style scoped src="../../css/settings/PersonaSetting.css"></style>
