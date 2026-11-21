<script setup lang="ts">
import type { ProviderCategory, ProviderProtocol } from '@/stores/providers'
import { computed, ref } from 'vue'
import { protocolRequiresBaseUrl, useProvidersStore } from '@/stores/providers'

const props = defineProps<{ category: ProviderCategory }>()
const emit = defineEmits<{ back: [], created: [id: string] }>()

const providersStore = useProvidersStore()

const form = ref({
  name: '',
  description: '',
  protocol: 'openai' as ProviderProtocol,
  baseUrl: '',
  apiKey: '',
})

const submitting = ref(false)

const protocolOptions = computed((): { value: ProviderProtocol, label: string }[] => {
  const llmOptions: { value: ProviderProtocol, label: string }[] = [
    { value: 'openai', label: 'OpenAI 兼容' },
    { value: 'anthropic', label: 'Anthropic' },
    { value: 'google', label: 'Google' },
  ]
  const ttsOptions: { value: ProviderProtocol, label: string }[] = [
    { value: 'openai', label: 'OpenAI 兼容' },
    { value: 'elevenlabs', label: 'ElevenLabs' },
    { value: 'lmnt', label: 'LMNT' },
    { value: 'hume', label: 'Hume' },
    { value: 'deepgram', label: 'Deepgram' },
  ]
  return props.category === 'tts' ? ttsOptions : llmOptions
})

const categoryLabel = computed(() => (props.category === 'llm' ? 'LLM' : '语音合成 (TTS)'))

// 部分 TTS 协议使用固定的官方接口地址，无需配置 Base URL
const showBaseUrl = computed(() => protocolRequiresBaseUrl(form.value.protocol))

const canSubmit = computed(() => form.value.name.trim() !== '' && (!showBaseUrl.value || form.value.baseUrl.trim() !== ''))

async function submit() {
  if (!canSubmit.value) return

  submitting.value = true
  try {
    const id = await providersStore.addProvider({
      id: '',
      name: form.value.name,
      category: props.category,
      protocol: form.value.protocol,
      baseUrl: form.value.baseUrl,
      apiKey: form.value.apiKey,
      description: form.value.description,
      models: [],
      selectedModelId: '',
      isValid: false,
      ...(props.category === 'tts' ? { voices: [], selectedVoiceId: '' } : {}),
    })
    emit('created', id)
  }
  finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="provider-detail">
    <header class="detail-header">
      <button class="back-button" title="返回" @click="emit('back')">
        ←
      </button>
      <span class="detail-title">添加 {{ categoryLabel }} Provider</span>
    </header>

    <div class="field">
      <label>名称</label>
      <input v-model="form.name" type="text" placeholder="Provider 名称">
    </div>

    <div class="field">
      <label>描述</label>
      <input v-model="form.description" type="text" placeholder="可选">
    </div>

    <div class="field">
      <label>协议</label>
      <select v-model="form.protocol">
        <option v-for="option in protocolOptions" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </select>
    </div>

    <div v-if="showBaseUrl" class="field">
      <label>Base URL</label>
      <input v-model="form.baseUrl" type="text" placeholder="https://...">
    </div>

    <div class="field">
      <label>API Key</label>
      <input v-model="form.apiKey" type="password" placeholder="sk-...">
    </div>

    <div class="detail-actions">
      <button class="action-button" :disabled="!canSubmit || submitting" @click="submit">
        {{ submitting ? '添加中...' : '添加' }}
      </button>
    </div>
  </div>
</template>

<style scoped src="../../css/settings/ProviderSetting.css"></style>
