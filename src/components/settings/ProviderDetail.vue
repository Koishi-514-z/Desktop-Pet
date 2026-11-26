<script setup lang="ts">
import type { ProviderModel, ProviderProtocol, ProviderVoice, RatingKind } from '@/stores/providers'
import { useLocalStorage } from '@vueuse/core'
import { computed, nextTick, ref, watch } from 'vue'
import {
  getProviderVoices,
  getRating,
  protocolRequiresApiKey,
  protocolRequiresBaseUrl,
  sortByRating,
  useProvidersStore,
} from '@/stores/providers'
import RatingStars from './RatingStars.vue'
import {
  CATEGORY_LABELS,
  PROTOCOL_OPTIONS,
  getInitial,
  getProtocolLabel,
  hashHue,
} from '@/utils/provider-options'

const props = defineProps<{ providerId: string }>()
const emit = defineEmits<{ back: [] }>()

const providersStore = useProvidersStore()

const provider = computed(() => providersStore.getProviderById(props.providerId))
const isDefault = computed(() => providersStore.isDefaultProvider(props.providerId))

// 本地编辑的连接配置，点击"保存"后才写回 store；模型与声线点击卡片即时生效
const form = ref({
  name: '',
  description: '',
  protocol: 'openai' as ProviderProtocol,
  baseUrl: '',
  apiKey: '',
})

function resetForm() {
  const p = provider.value
  if (!p) return
  form.value = {
    name: p.name,
    description: p.description ?? '',
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
  }
}

watch(() => props.providerId, resetForm, { immediate: true })

// 表单是否有未保存的修改
const dirty = computed(() => {
  const p = provider.value
  if (!p) return false
  const f = form.value
  return (
    f.name !== p.name ||
    f.description !== (p.description ?? '') ||
    f.protocol !== p.protocol ||
    f.baseUrl !== p.baseUrl ||
    f.apiKey !== p.apiKey
  )
})

const showApiKey = ref(false)
const saving = ref(false)
const refreshing = ref(false)

const protocolOptions = computed(() => PROTOCOL_OPTIONS[provider.value?.category ?? 'llm'])

// 部分 TTS 协议使用固定的官方接口地址，无需配置 Base URL
const showBaseUrl = computed(() => protocolRequiresBaseUrl(form.value.protocol))

const isCurrent = computed(() => !!provider.value && providersStore.isCurrentProvider(provider.value))

function setCurrent() {
  if (provider.value) providersStore.setCurrentProvider(provider.value)
}

async function save() {
  if (!provider.value || !dirty.value) return

  saving.value = true
  try {
    await providersStore.updateProvider(provider.value.id, { ...form.value })
  } finally {
    saving.value = false
  }
}

async function refresh() {
  if (!provider.value) return

  refreshing.value = true
  try {
    await providersStore.refreshProviderInfo(provider.value.id)
  } finally {
    refreshing.value = false
  }
}

// 列表较长时显示搜索框
const SEARCH_THRESHOLD = 6

function matches(item: { id: string; name: string; description?: string }, query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [item.id, item.name, item.description ?? ''].some((s) => s.toLowerCase().includes(q))
}

// 评分：打分后可以按评分排列，喜欢的模型 / 声线排在前面（所有 provider 共用这个开关）
const sortByRatingEnabled = useLocalStorage('settings/providers/sortByRating', false)

function ratingOf(kind: RatingKind, itemId: string) {
  return provider.value ? getRating(provider.value, kind, itemId) : 0
}

function rate(kind: RatingKind, itemId: string, rating: number) {
  if (provider.value) providersStore.setRating(provider.value.id, kind, itemId, rating)
}

function arrange<T extends { id: string }>(items: T[], kind: RatingKind): T[] {
  return sortByRatingEnabled.value && provider.value ? sortByRating(items, provider.value, kind) : items
}

const hasRatings = computed(() =>
  Object.values(provider.value?.ratings ?? {}).some((ratings) => Object.keys(ratings).length > 0),
)

// 模型
const modelQuery = ref('')
const models = computed(() => provider.value?.models ?? [])
const filteredModels = computed(() => arrange(models.value.filter((m) => matches(m, modelQuery.value)), 'models'))
const selectedModel = computed(() => models.value.find((m) => m.id === provider.value?.selectedModelId))

function selectModel(model: ProviderModel) {
  if (!provider.value) return
  providersStore.updateProvider(provider.value.id, { selectedModelId: model.id })
}

// 声线：手动输入的音色在前，之后是接口获取的声线
const voiceQuery = ref('')
const voices = computed(() => (provider.value ? getProviderVoices(provider.value) : []))
const filteredVoices = computed(() => arrange(voices.value.filter((v) => matches(v, voiceQuery.value)), 'voices'))
const selectedVoice = computed(() => voices.value.find((v) => v.id === provider.value?.selectedVoiceId))
const customVoiceIds = computed(() => new Set((provider.value?.customVoices ?? []).map((v) => v.id)))

function selectVoice(voice: ProviderVoice) {
  if (!provider.value) return
  providersStore.updateProvider(provider.value.id, { selectedVoiceId: voice.id })
}

// 手动输入音色 ID：列表中没有想要的音色时使用（如 Fish Audio 声线库中的其他声线）
const customVoiceId = ref('')
const customVoiceName = ref('')
const voiceGrid = ref<HTMLElement | null>(null)

async function addCustomVoice() {
  if (!provider.value || !customVoiceId.value.trim()) return
  providersStore.addCustomVoice(provider.value.id, { id: customVoiceId.value, name: customVoiceName.value })
  customVoiceId.value = ''
  customVoiceName.value = ''
  voiceQuery.value = ''
  // 声线很多时，刚加上（或者列表里本来就有）并选中的音色可能不在能看到的地方，滚过去。
  // 设置面板底部悬浮着操作栏，滚动时会给它让出位置（见 SettingBox.css 中的 scroll-padding-bottom）
  await nextTick()
  voiceGrid.value?.querySelector('.voice-card.selected')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}

function removeCustomVoice(voice: ProviderVoice) {
  if (provider.value) providersStore.removeCustomVoice(provider.value.id, voice.id)
}

function voiceAvatarStyle(voice: ProviderVoice) {
  const hue = hashHue(voice.id)
  return {
    background: `linear-gradient(135deg, hsl(${hue} 70% 62%), hsl(${(hue + 40) % 360} 65% 48%))`,
  }
}

// 自定义音色上传（仅支持 uploadVoice 的 provider，如 index-tts）
const voiceName = ref('')
const voiceFile = ref<File | null>(null)
const voiceFileInput = ref<HTMLInputElement | null>(null)
const uploadingVoice = ref(false)
const voiceMessage = ref<{ type: 'success' | 'error'; text: string } | null>(null)
const draggingFile = ref(false)

const canUploadVoice = computed(
  () => voiceName.value.trim() !== '' && voiceFile.value !== null && !uploadingVoice.value,
)

function setVoiceFile(file: File | null) {
  voiceFile.value = file
  // 默认以文件名作为音色名
  if (file && voiceName.value.trim() === '') voiceName.value = file.name.replace(/\.[^.]+$/, '')
}

function onVoiceFileChange(event: Event) {
  setVoiceFile((event.target as HTMLInputElement).files?.[0] ?? null)
}

function onVoiceFileDrop(event: DragEvent) {
  draggingFile.value = false
  const file = event.dataTransfer?.files?.[0]
  if (file && file.type.startsWith('audio/')) setVoiceFile(file)
}

async function uploadVoice() {
  if (!provider.value || !canUploadVoice.value) return

  uploadingVoice.value = true
  voiceMessage.value = null
  try {
    const voice = await providersStore.uploadProviderVoice(
      provider.value.id,
      voiceFile.value!,
      voiceName.value.trim(),
    )
    voiceMessage.value = { type: 'success', text: `已上传音色「${voice.name}」` }
    voiceName.value = ''
    voiceFile.value = null
    if (voiceFileInput.value) voiceFileInput.value.value = ''
  } catch (error) {
    console.error(error)
    voiceMessage.value = {
      type: 'error',
      text: `上传失败：${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    uploadingVoice.value = false
  }
}

async function deleteVoice(voice: ProviderVoice) {
  if (!provider.value) return
  if (!confirm(`确定删除音色「${voice.name}」吗？`)) return

  try {
    await providersStore.deleteProviderVoice(provider.value.id, voice.id)
    voiceMessage.value = null
  } catch (error) {
    console.error(error)
    voiceMessage.value = {
      type: 'error',
      text: `删除失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
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
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
      </button>
      <div class="provider-avatar" :class="provider.category">
        {{ getInitial(provider.name) }}
      </div>
      <div class="detail-heading">
        <span class="detail-title">{{ provider.name }}</span>
        <span class="detail-subtitle">
          {{ CATEGORY_LABELS[provider.category] }} · {{ getProtocolLabel(provider.protocol) }}
        </span>
      </div>
      <span class="status-badge" :class="{ valid: provider.isValid }">
        <i class="status-dot" />
        {{ provider.isValid ? '可用' : '未验证' }}
      </span>
    </header>

    <!-- 基本信息 -->
    <section class="panel">
      <h4 class="panel-title">基本信息</h4>
      <div class="field-grid">
        <div class="field">
          <label>名称</label>
          <input v-model="form.name" type="text" placeholder="Provider 名称" />
        </div>
        <div class="field">
          <label>描述</label>
          <input v-model="form.description" type="text" placeholder="可选" />
        </div>
      </div>
    </section>

    <!-- 连接配置 -->
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
        <label>Base URL</label>
        <input v-model="form.baseUrl" type="text" placeholder="https://..." />
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
    </section>

    <!-- 模型 -->
    <section class="panel">
      <div class="panel-head">
        <h4 class="panel-title">
          模型
          <span v-if="models.length > 0" class="count">{{ models.length }}</span>
        </h4>
        <span v-if="selectedModel" class="panel-hint" :title="selectedModel.id">
          当前：{{ selectedModel.name }}
          <span v-if="ratingOf('models', selectedModel.id)" class="hint-rating">★{{ ratingOf('models', selectedModel.id) }}</span>
        </span>
        <button
          v-if="models.length > 1"
          type="button"
          class="chip small"
          :class="{ active: sortByRatingEnabled }"
          :title="hasRatings ? '评分高的排在前面' : '点卡片上的星星给模型和声线打分后，可以按评分排列'"
          @click="sortByRatingEnabled = !sortByRatingEnabled"
        >
          评分优先
        </button>
      </div>

      <template v-if="models.length > 0">
        <div v-if="models.length > SEARCH_THRESHOLD" class="search-box">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input v-model="modelQuery" type="text" placeholder="搜索模型" />
        </div>

        <div class="option-grid">
          <div
            v-for="model in filteredModels"
            :key="model.id"
            role="button"
            tabindex="0"
            class="option-card"
            :class="{ selected: model.id === provider.selectedModelId }"
            :title="model.id"
            @click="selectModel(model)"
            @keydown.enter.prevent="selectModel(model)"
            @keydown.space.prevent="selectModel(model)"
          >
            <span class="option-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" />
                <path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
              </svg>
            </span>
            <span class="option-text">
              <span class="option-name">{{ model.name }}</span>
              <span v-if="model.description" class="option-meta">{{ model.description }}</span>
              <span v-else-if="model.id !== model.name" class="option-meta mono">{{ model.id }}</span>
              <RatingStars
                class="option-rating"
                :label="`${model.name} 的评分`"
                :model-value="ratingOf('models', model.id)"
                @update:model-value="rate('models', model.id, $event)"
              />
            </span>
            <span class="option-check">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
            </span>
          </div>
        </div>
        <p v-if="filteredModels.length === 0" class="empty-hint">没有匹配的模型</p>
      </template>

      <p v-else class="empty-state">
        暂无可用模型。请填写正确的连接配置并保存，或点击下方「刷新」重新获取。
      </p>
    </section>

    <!-- 声线 -->
    <section v-if="provider.category === 'tts'" class="panel">
      <div class="panel-head">
        <h4 class="panel-title">
          声线
          <span v-if="voices.length > 0" class="count">{{ voices.length }}</span>
        </h4>
        <span v-if="selectedVoice" class="panel-hint" :title="selectedVoice.id">
          当前：{{ selectedVoice.name }}
          <span v-if="ratingOf('voices', selectedVoice.id)" class="hint-rating">★{{ ratingOf('voices', selectedVoice.id) }}</span>
        </span>
        <button
          v-if="voices.length > 1"
          type="button"
          class="chip small"
          :class="{ active: sortByRatingEnabled }"
          :title="hasRatings ? '评分高的排在前面' : '点卡片上的星星给模型和声线打分后，可以按评分排列'"
          @click="sortByRatingEnabled = !sortByRatingEnabled"
        >
          评分优先
        </button>
      </div>

      <!-- 手动输入音色 ID 放在声线列表上方：放在下面时，列表的高度一变（搜索、刷新、增删音色）就会把它挤出视野，
           或者挤到悬浮在底部的操作栏后面，看起来像是消失了 -->
      <div class="field-row custom-voice-row">
        <input
          v-model="customVoiceId"
          class="custom-voice-id"
          type="text"
          placeholder="手动输入音色 ID"
          @keydown.enter="addCustomVoice"
        />
        <input
          v-model="customVoiceName"
          class="custom-voice-name"
          type="text"
          placeholder="名称（可选）"
          @keydown.enter="addCustomVoice"
        />
        <button class="action-button" type="button" :disabled="!customVoiceId.trim()" @click="addCustomVoice">
          使用
        </button>
      </div>
      <p class="panel-note">列表里没有想要的音色时，可以输入服务商提供的音色 ID，合成语音时会使用它。</p>

      <template v-if="voices.length > 0">
        <div v-if="voices.length > SEARCH_THRESHOLD" class="search-box">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input v-model="voiceQuery" type="text" placeholder="搜索声线" />
        </div>

        <div ref="voiceGrid" class="option-grid voice-grid">
          <div
            v-for="voice in filteredVoices"
            :key="voice.id"
            role="button"
            tabindex="0"
            class="option-card voice-card"
            :class="{ selected: voice.id === provider.selectedVoiceId }"
            :title="voice.id"
            @click="selectVoice(voice)"
            @keydown.enter.prevent="selectVoice(voice)"
            @keydown.space.prevent="selectVoice(voice)"
          >
            <span class="voice-avatar" :style="voiceAvatarStyle(voice)">
              {{ getInitial(voice.name) }}
            </span>
            <span class="option-text">
              <span class="option-name">{{ voice.name }}</span>
              <span v-if="voice.description" class="option-meta">{{ voice.description }}</span>
              <span v-else-if="voice.id !== voice.name" class="option-meta mono">{{ voice.id }}</span>
              <RatingStars
                class="option-rating"
                :label="`${voice.name} 的评分`"
                :model-value="ratingOf('voices', voice.id)"
                @update:model-value="rate('voices', voice.id, $event)"
              />
            </span>
            <button
              v-if="customVoiceIds.has(voice.id)"
              type="button"
              class="option-delete"
              title="移除手动输入的音色"
              @click.stop="removeCustomVoice(voice)"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
            <button
              v-else-if="provider.deleteVoice"
              type="button"
              class="option-delete"
              title="删除音色"
              @click.stop="deleteVoice(voice)"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
              </svg>
            </button>
            <span class="option-check">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
            </span>
          </div>
        </div>
        <p v-if="filteredVoices.length === 0" class="empty-hint">没有匹配的声线</p>
      </template>

      <p v-else class="empty-state">
        {{ provider.uploadVoice ? '暂无声线，可以在上方手动输入音色 ID，或在下方上传参考音频创建音色。' : '暂无可用声线，可以在上方手动输入音色 ID。' }}
      </p>

    </section>

    <!-- 上传自定义音色 -->
    <section v-if="provider.uploadVoice" class="panel">
      <h4 class="panel-title">上传音色</h4>

      <label
        class="dropzone"
        :class="{ dragging: draggingFile, filled: voiceFile }"
        @dragover.prevent="draggingFile = true"
        @dragleave="draggingFile = false"
        @drop.prevent="onVoiceFileDrop"
      >
        <input
          ref="voiceFileInput"
          class="visually-hidden"
          type="file"
          accept="audio/*"
          @change="onVoiceFileChange"
        />
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <template v-if="voiceFile">
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
          </template>
          <template v-else>
            <path d="M12 16V4M7 9l5-5 5 5" />
            <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
          </template>
        </svg>
        <span v-if="voiceFile" class="dropzone-text">
          <span class="dropzone-title">{{ voiceFile.name }}</span>
          <span class="dropzone-sub">{{ formatFileSize(voiceFile.size) }} · 点击更换</span>
        </span>
        <span v-else class="dropzone-text">
          <span class="dropzone-title">点击选择或拖入参考音频</span>
          <span class="dropzone-sub">支持常见音频格式，建议 3~10 秒的清晰人声</span>
        </span>
      </label>

      <div class="field-row">
        <input v-model="voiceName" type="text" placeholder="音色名称" />
        <button class="action-button primary" type="button" :disabled="!canUploadVoice" @click="uploadVoice">
          {{ uploadingVoice ? '上传中...' : '上传' }}
        </button>
      </div>

      <p v-if="voiceMessage" class="message" :class="voiceMessage.type">
        {{ voiceMessage.text }}
      </p>
    </section>

    <footer class="detail-actions">
      <button class="action-button danger" :disabled="isDefault" @click="remove">删除</button>
      <span class="spacer" />
      <button class="action-button" :disabled="refreshing" @click="refresh">
        <svg class="button-icon" :class="{ spinning: refreshing }" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4" />
          <path d="M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4" />
        </svg>
        {{ refreshing ? '刷新中...' : '刷新' }}
      </button>
      <button class="action-button" :class="{ active: isCurrent }" @click="setCurrent">
        {{ isCurrent ? '使用中' : '设为当前' }}
      </button>
      <button class="action-button primary" :class="{ dirty }" :disabled="saving || !dirty" @click="save">
        {{ saving ? '保存中...' : dirty ? '保存修改' : '已保存' }}
      </button>
    </footer>
  </div>
</template>

<style scoped src="../../css/settings/ProviderSetting.css"></style>
