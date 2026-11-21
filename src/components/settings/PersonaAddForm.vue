<script setup lang="ts">
import { computed, ref } from 'vue'
import { usePersonaStore } from '@/stores/persona'

const emit = defineEmits<{ back: [], created: [id: string] }>()

const personaStore = usePersonaStore()

const form = ref({
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
        ←
      </button>
      <span class="detail-title">添加人设</span>
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

    <div class="detail-actions">
      <button class="action-button" :disabled="!canSubmit" @click="submit">
        添加
      </button>
    </div>
  </div>
</template>

<style scoped src="../../css/settings/PersonaSetting.css"></style>
