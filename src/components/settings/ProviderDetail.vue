<script setup lang="ts">
import type { ProviderProtocol } from '@/stores/providers'
import { computed, ref, watch } from 'vue'
import { protocolRequiresApiKey, protocolRequiresBaseUrl, useProvidersStore } from '@/stores/providers'

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
    { value: 'index-tts', label: 'IndexTTS (本地部署)' },
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

// 自定义音色上传（仅支持 uploadVoice 的 provider，如 index-tts）
const voiceName = ref('')
const voiceFile = ref<File | null>(null)
const voiceFileInput = ref<HTMLInputElement | null>(null)
const uploadingVoice = ref(false)
const voiceMessage = ref('')

const canUploadVoice = computed(() => voiceName.value.trim() !== '' && voiceFile.value !== null && !uploadingVoice.value)

function onVoiceFileChange(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0] ?? null
  voiceFile.value = file
  // 默认以文件名作为音色名
  if (file && voiceName.value.trim() === '') voiceName.value = file.name.replace(/\.[^.]+$/, '')
}

async function uploadVoice() {
  if (!provider.value || !canUploadVoice.value) return

  uploadingVoice.value = true
  voiceMessage.value = ''
  try {
    const voice = await providersStore.uploadProviderVoice(provider.value.id, voiceFile.value!, voiceName.value.trim())
    voiceMessage.value = `已上传音色「${voice.name}」`
    voiceName.value = ''
    voiceFile.value = null
    if (voiceFileInput.value) voiceFileInput.value.value = ''
  }
  catch (error) {
    console.error(error)
    voiceMessage.value = `上传失败：${error instanceof Error ? error.message : String(error)}`
  }
  finally {
    uploadingVoice.value = false
  }
}

async function deleteSelectedVoice() {
  if (!provider.value || !form.value.selectedVoiceId) return
  if (!confirm(`确定删除音色「${form.value.selectedVoiceId}」吗？`)) return

  try {
    await providersStore.deleteProviderVoice(provider.value.id, form.value.selectedVoiceId)
    voiceMessage.value = ''
  }
  catch (error) {
    console.error(error)
    voiceMessage.value = `删除失败：${error instanceof Error ? error.message : String(error)}`
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
        <input v-model="form.apiKey" :type="showApiKey ? 'text' : 'password'" :placeholder="protocolRequiresApiKey(form.protocol) ? 'sk-...' : '可选'">
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
      <div class="field-row">
        <select v-model="form.selectedVoiceId">
          <option v-for="voice in provider.voices" :key="voice.id" :value="voice.id">
            {{ voice.name }}
          </option>
        </select>
        <button v-if="provider.deleteVoice" class="field-action" type="button" @click="deleteSelectedVoice">
          删除
        </button>
      </div>
    </div>

    <div v-if="provider.uploadVoice" class="field">
      <label>上传音色参考音频</label>
      <input v-model="voiceName" type="text" placeholder="音色名称">
      <div class="field-row">
        <input ref="voiceFileInput" type="file" accept="audio/*" @change="onVoiceFileChange">
        <button class="field-action" type="button" :disabled="!canUploadVoice" @click="uploadVoice">
          {{ uploadingVoice ? '上传中...' : '上传' }}
        </button>
      </div>
      <label v-if="voiceMessage">{{ voiceMessage }}</label>
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
