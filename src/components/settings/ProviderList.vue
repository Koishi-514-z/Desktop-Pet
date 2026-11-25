<script setup lang="ts">
import type { Provider, ProviderCategory } from '@/stores/providers'
import { useProvidersStore } from '@/stores/providers'
import { CATEGORY_LABELS, CATEGORY_SHORT_LABELS, getInitial, getProtocolLabel } from '@/utils/provider-options'

const emit = defineEmits<{
  select: [id: string]
  add: [category: ProviderCategory]
}>()

const providersStore = useProvidersStore()

const sections: { category: ProviderCategory; getProviders: () => Provider[] }[] = [
  { category: 'llm', getProviders: () => providersStore.getLLMProviders() },
  { category: 'tts', getProviders: () => providersStore.getTTSProviders() },
  { category: 'asr', getProviders: () => providersStore.getASRProviders() },
]

function isCurrent(provider: Provider) {
  return providersStore.isCurrentProvider(provider)
}

function setCurrent(provider: Provider) {
  providersStore.setCurrentProvider(provider)
}

// 卡片底部展示的当前模型 / 声线
function getSelectionSummary(provider: Provider) {
  const model = provider.models.find((m) => m.id === provider.selectedModelId)
  const voice = provider.voices?.find((v) => v.id === provider.selectedVoiceId)
  return [model?.name, voice?.name].filter(Boolean).join(' · ')
}

function remove(provider: Provider) {
  providersStore.removeProvider(provider.id)
}
</script>

<template>
  <div class="provider-list">
    <section v-for="section in sections" :key="section.category" class="provider-section">
      <h3 class="section-title">
        {{ CATEGORY_LABELS[section.category] }}
        <span class="count">{{ section.getProviders().length }}</span>
      </h3>

      <div class="provider-cards">
        <div
          v-for="provider in section.getProviders()"
          :key="provider.id"
          class="provider-card"
          :class="{ current: isCurrent(provider) }"
          @click="emit('select', provider.id)"
        >
          <div class="card-header">
            <div class="provider-avatar small" :class="provider.category">
              {{ getInitial(provider.name) }}
            </div>
            <div class="card-heading">
              <span class="card-name">{{ provider.name }}</span>
              <span class="card-protocol">{{ getProtocolLabel(provider.protocol) }}</span>
            </div>
            <span
              class="card-badge"
              :class="{ valid: provider.isValid }"
              :title="provider.isValid ? '可用' : '未验证'"
            />
          </div>

          <p class="card-description">
            {{ provider.description || provider.baseUrl || '官方接口' }}
          </p>

          <p class="card-selection" :class="{ empty: !getSelectionSummary(provider) }">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" />
            </svg>
            {{ getSelectionSummary(provider) || '未获取到模型' }}
          </p>

          <div class="card-actions">
            <button
              class="card-action"
              :class="{ active: isCurrent(provider) }"
              :disabled="provider.category === 'llm' && !provider.isValid && !isCurrent(provider)"
              @click.stop="setCurrent(provider)"
            >
              {{ isCurrent(provider) ? '使用中' : '设为当前' }}
            </button>
            <button
              class="card-remove"
              title="删除"
              :disabled="providersStore.isDefaultProvider(provider.id)"
              @click.stop="remove(provider)"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
              </svg>
            </button>
          </div>
        </div>

        <button class="provider-card add-card" type="button" @click="emit('add', section.category)">
          <span class="add-icon">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          </span>
          <span>添加 {{ CATEGORY_SHORT_LABELS[section.category] }} Provider</span>
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped src="../../css/settings/ProviderSetting.css"></style>
