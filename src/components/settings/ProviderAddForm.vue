<script setup lang="ts">
import type { ProviderCategory, ProviderProtocol } from '@/stores/providers'
import { computed, ref } from 'vue'
import { protocolRequiresApiKey, protocolRequiresBaseUrl, useProvidersStore } from '@/stores/providers'
import { CATEGORY_LABELS, PROTOCOL_OPTIONS } from '@/utils/provider-options'

const props = defineProps<{ category: ProviderCategory }>()
const emit = defineEmits<{ back: []; created: [id: string] }>()

const providersStore = useProvidersStore()

const form = ref({
  name: '',
  description: '',
  protocol: 'openai' as ProviderProtocol,
  baseUrl: '',
  apiKey: '',
})

const submitting = ref(false)
const showApiKey = ref(false)

const protocolOptions = computed(() => PROTOCOL_OPTIONS[props.category])

// 部分 TTS 协议使用固定的官方接口地址，无需配置 Base URL
const showBaseUrl = computed(() => protocolRequiresBaseUrl(form.value.protocol))

const canSubmit = computed(
  () => form.value.name.trim() !== '' && (!showBaseUrl.value || form.value.baseUrl.trim() !== ''),
)

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
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="provider-detail">
    <header class="detail-header">
      <button class="back-button" title="返回" @click="emit('back')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
      </button>
      <div class="provider-avatar" :class="category">+</div>
      <div class="detail-heading">
        <span class="detail-title">添加 Provider</span>
        <span class="detail-subtitle">{{ CATEGORY_LABELS[category] }}</span>
      </div>
    </header>

    <section class="panel">
      <h4 class="panel-title">基本信息</h4>
      <div class="field-grid">
        <div class="field">
          <label>名称 <span class="required">*</span></label>
          <input v-model="form.name" type="text" placeholder="Provider 名称" />
        </div>
        <div class="field">
          <label>描述</label>
          <input v-model="form.description" type="text" placeholder="可选" />
        </div>
      </div>
    </section>

    <section class="panel">
      <h4 class="panel-title">连接配置</h4>

      <div class="field">
        <label>协议</label>
        <div class="chip-group">
          <button
            v-for="option in protocolOptions"
            :key="option.value"
            type="button"
            class="chip"
            :class="{ active: form.protocol === option.value }"
            @click="form.protocol = option.value"
          >
            {{ option.label }}
          </button>
        </div>
      </div>

      <div v-if="showBaseUrl" class="field">
        <label>Base URL <span class="required">*</span></label>
        <input
          v-model="form.baseUrl"
          type="text"
          :placeholder="form.protocol === 'index-tts' ? 'http://127.0.0.1:7861/v1' : form.protocol === 'dashscope' ? 'https://dashscope.aliyuncs.com' : 'https://...'"
        />
      </div>

      <div class="field">
        <label>API Key</label>
        <div class="input-with-icon">
          <input
            v-model="form.apiKey"
            :type="showApiKey ? 'text' : 'password'"
            :placeholder="protocolRequiresApiKey(form.protocol) ? 'sk-...' : '可选'"
          />
          <button
            class="input-icon-button"
            type="button"
            :title="showApiKey ? '隐藏' : '显示'"
            @click="showApiKey = !showApiKey"
          >
            <svg v-if="showApiKey" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <svg v-else viewBox="0 0 24 24" aria-hidden="true">
              <path d="M17.9 17.9A10.4 10.4 0 0 1 12 19c-6.5 0-10-7-10-7a18 18 0 0 1 4.1-5" />
              <path d="M9.9 5.2A9.6 9.6 0 0 1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-2.2 3.2" />
              <path d="M3 3l18 18" />
            </svg>
          </button>
        </div>
      </div>

      <p class="panel-note">添加后会自动验证连接并获取可用的模型{{ category === 'tts' ? '与声线' : '' }}列表。</p>
    </section>

    <footer class="detail-actions">
      <span class="spacer" />
      <button class="action-button" @click="emit('back')">取消</button>
      <button class="action-button primary" :disabled="!canSubmit || submitting" @click="submit">
        {{ submitting ? '添加中...' : '添加' }}
      </button>
    </footer>
  </div>
</template>

<style scoped src="../../css/settings/ProviderSetting.css"></style>
