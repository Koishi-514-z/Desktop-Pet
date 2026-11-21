<script setup lang="ts">
import type { ProviderProtocol } from '@/stores/providers'
import { computed, ref, watch } from 'vue'
import { protocolRequiresBaseUrl, useProvidersStore } from '@/stores/providers'

const props = defineProps<{ providerId: string }>()
const emit = defineEmits<{ back: [] }>()

const providersStore = useProvidersStore()

const provider = computed(() => providersStore.getProviderById(props.providerId))
const isDefault = computed(() => providersStore.isDefaultProvider(props.providerId))

// 本地编辑状态，点击"保存"后才写回 store
const form = ref({
  name: '',
  description: '',
  protocol: 'openai' as ProviderProtocol,
  baseUrl: '',
  apiKey: '',
  selectedModelId: '',
  selectedVoiceId: '',
})

const showApiKey = ref(false)
const saving = ref(false)
const refreshing = ref(false)

watch(provider, (p) => {
  if (!p) return
  form.value = {
    name: p.name,
    description: p.description ?? '',
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    selectedModelId: p.selectedModelId,
    selectedVoiceId: p.selectedVoiceId ?? '',
  }
}, { immediate: true, deep: true })

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
  return provider.value?.category === 'tts' ? ttsOptions : llmOptions
})

// 部分 TTS 协议使用固定的官方接口地址，无需配置 Base URL
const showBaseUrl = computed(() => protocolRequiresBaseUrl(form.value.protocol))

function isCurrent() {
  if (!provider.value) return false
  return provider.value.category === 'llm'
    ? providersStore.currentLLMProviderId === provider.value.id
    : providersStore.currentTTSProviderId === provider.value.id
}

function setCurrent() {
  if (!provider.value) return
  if (provider.value.category === 'llm') providersStore.currentLLMProviderId = provider.value.id
  else providersStore.currentTTSProviderId = provider.value.id
}

async function save() {
  if (!provider.value) return

  saving.value = true
  try {
    await providersStore.updateProvider(provider.value.id, { ...form.value })
  }
  finally {
    saving.value = false
  }
}

async function refresh() {
  if (!provider.value) return

  refreshing.value = true
  try {
    await providersStore.refreshProviderInfo(provider.value.id)
  }
  finally {
    refreshing.value = false
  }
}

function remove() {
  if (!provider.value) return
  providersStore.removeProvider(provider.value.id)
  emit('back')
}
</script>

<template>
  <div v-if="provider" class="provider-detail">
    <header class="detail-header">
      <button class="back-button" title="返回" @click="emit('back')">
        ←
      </button>
      <span class="detail-title">{{ provider.name }}</span>
      <span class="status-badge" :class="{ valid: provider.isValid }">
        {{ provider.isValid ? '可用' : '未验证' }}
      </span>
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
      <div class="field-row">
        <input v-model="form.apiKey" :type="showApiKey ? 'text' : 'password'" placeholder="sk-...">
        <button class="field-action" type="button" @click="showApiKey = !showApiKey">
          {{ showApiKey ? '隐藏' : '显示' }}
        </button>
      </div>
    </div>

    <div v-if="provider.models.length > 0" class="field">
      <label>当前模型</label>
      <select v-model="form.selectedModelId">
        <option v-for="model in provider.models" :key="model.id" :value="model.id">
          {{ model.name }}
        </option>
      </select>
    </div>

    <div v-if="provider.voices && provider.voices.length > 0" class="field">
      <label>当前声线</label>
      <select v-model="form.selectedVoiceId">
        <option v-for="voice in provider.voices" :key="voice.id" :value="voice.id">
          {{ voice.name }}
        </option>
      </select>
    </div>

    <div class="detail-actions">
      <button class="action-button" :disabled="refreshing" @click="refresh">
        {{ refreshing ? '刷新中...' : (provider.category === 'tts' ? '刷新模型/声线列表' : '刷新模型列表') }}
      </button>
      <button class="action-button" :disabled="saving" @click="save">
        {{ saving ? '保存中...' : '保存' }}
      </button>
      <button class="action-button" :class="{ active: isCurrent() }" @click="setCurrent">
        {{ isCurrent() ? '使用中' : '设为当前' }}
      </button>
      <button class="action-button danger" :disabled="isDefault" @click="remove">
        删除
      </button>
    </div>
  </div>
</template>

<style scoped src="../../css/settings/ProviderSetting.css"></style>
