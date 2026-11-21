<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { usePersonaStore } from '@/stores/persona'

const props = defineProps<{ personaId: string }>()
const emit = defineEmits<{ back: [] }>()

const personaStore = usePersonaStore()

const persona = computed(() => personaStore.getPersonaById(props.personaId))
const isCurrent = computed(() => personaStore.currentPersonaId === props.personaId)
const canRemove = computed(() => !personaStore.isDefaultPersona(props.personaId))
const systemPrompt = computed(() => personaStore.buildSystemPrompt(props.personaId))

const form = ref({
  name: '',
  personality: '',
  background: '',
  speakingStyle: '',
})

watch(persona, (p) => {
  if (!p) return
  form.value = {
    name: p.name,
    personality: p.personality,
    background: p.background ?? '',
    speakingStyle: p.speakingStyle ?? '',
  }
}, { immediate: true, deep: true })

function save() {
  if (!persona.value) return
  personaStore.updatePersona(persona.value.id, { ...form.value })
}

function remove() {
  if (!persona.value) return
  personaStore.removePersona(persona.value.id)
  emit('back')
}
</script>

<template>
  <div v-if="persona" class="persona-detail">
    <header class="detail-header">
      <button class="back-button" title="返回" @click="emit('back')">
        ←
      </button>
      <span class="detail-title">{{ persona.name }}</span>
      <span class="status-badge" :class="{ valid: isCurrent }">
        {{ isCurrent ? '使用中' : '未选用' }}
      </span>
    </header>

    <div class="field">
      <label>名字</label>
      <input v-model="form.name" type="text" placeholder="人设名字">
    </div>

    <div class="field">
      <label>性格特点</label>
      <textarea v-model="form.personality" rows="3" placeholder="描述性格，如：活泼、温柔、有点小调皮…" />
    </div>

    <div class="field">
      <label>背景故事</label>
      <textarea v-model="form.background" rows="4" placeholder="可选，描述角色来历、经历等背景信息" />
    </div>

    <div class="field">
      <label>说话风格</label>
      <textarea v-model="form.speakingStyle" rows="3" placeholder="可选，描述说话方式，如：喜欢用颜文字、语气轻快…" />
    </div>

    <div class="field">
      <label>系统提示词预览</label>
      <pre class="prompt-preview">{{ systemPrompt }}</pre>
    </div>

    <div class="detail-actions">
      <button class="action-button" @click="save">
        保存
      </button>
      <button class="action-button" :class="{ active: isCurrent }" @click="personaStore.switchPersona(persona.id)">
        {{ isCurrent ? '使用中' : '设为当前' }}
      </button>
      <button class="action-button danger" :disabled="!canRemove" @click="remove">
        删除
      </button>
    </div>
  </div>
</template>

<style scoped src="../../css/settings/PersonaSetting.css"></style>
