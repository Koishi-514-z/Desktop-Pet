<script setup lang="ts">
import type { ProviderCategory } from '@/stores/providers'
import { useProvidersStore } from '@/stores/providers'

const emit = defineEmits<{
  select: [id: string]
  add: [category: ProviderCategory]
}>()

const providersStore = useProvidersStore()

function isCurrent(id: string, category: ProviderCategory) {
  return category === 'llm'
    ? providersStore.currentLLMProviderId === id
    : providersStore.currentTTSProviderId === id
}

function setCurrent(id: string, category: ProviderCategory) {
  if (category === 'llm') providersStore.currentLLMProviderId = id
  else providersStore.currentTTSProviderId = id
}

function remove(id: string) {
  providersStore.removeProvider(id)
}
</script>

<template>
  <div class="provider-list">
    <section class="provider-section">
      <h3 class="section-title">
        LLM
      </h3>
      <div class="provider-cards">
        <div
          v-for="provider in providersStore.getLLMProviders()"
          :key="provider.id"
          class="provider-card"
          :class="{ current: isCurrent(provider.id, 'llm') }"
          @click="emit('select', provider.id)"
        >
          <div class="card-header">
            <span class="card-name">{{ provider.name }}</span>
            <span class="card-badge" :class="{ valid: provider.isValid }" />
          </div>
          <p class="card-description">
            {{ provider.description || provider.baseUrl }}
          </p>
          <div class="card-actions">
            <button
              class="card-action"
              :class="{ active: isCurrent(provider.id, 'llm') }"
              :disabled="!provider.isValid"
              @click.stop="setCurrent(provider.id, 'llm')"
            >
              {{ isCurrent(provider.id, 'llm') ? '使用中' : '设为当前' }}
            </button>
            <button class="card-remove" title="删除" :disabled="providersStore.isDefaultProvider(provider.id)" @click.stop="remove(provider.id)">
              ×
            </button>
          </div>
        </div>

        <div class="provider-card add-card" @click="emit('add', 'llm')">
          <span class="add-icon">+</span>
          <span>添加 LLM Provider</span>
        </div>
      </div>
    </section>

    <section class="provider-section">
      <h3 class="section-title">
        语音合成 (TTS)
      </h3>
      <div class="provider-cards">
        <div
          v-for="provider in providersStore.getTTSProviders()"
          :key="provider.id"
          class="provider-card"
          :class="{ current: isCurrent(provider.id, 'tts') }"
          @click="emit('select', provider.id)"
        >
          <div class="card-header">
            <span class="card-name">{{ provider.name }}</span>
            <span class="card-badge" :class="{ valid: provider.isValid }" />
          </div>
          <p class="card-description">
            {{ provider.description || provider.baseUrl }}
          </p>
          <div class="card-actions">
            <button
              class="card-action"
              :class="{ active: isCurrent(provider.id, 'tts') }"
              @click.stop="setCurrent(provider.id, 'tts')"
            >
              {{ isCurrent(provider.id, 'tts') ? '使用中' : '设为当前' }}
            </button>
            <button class="card-remove" title="删除" :disabled="providersStore.isDefaultProvider(provider.id)" @click.stop="remove(provider.id)">
              ×
            </button>
          </div>
        </div>

        <div class="provider-card add-card" @click="emit('add', 'tts')">
          <span class="add-icon">+</span>
          <span>添加 TTS Provider</span>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped src="../../css/settings/ProviderSetting.css"></style>
