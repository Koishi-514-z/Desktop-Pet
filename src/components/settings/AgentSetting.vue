<script setup lang="ts">
import type { Ref } from 'vue'
import type { ModelChoice } from '@/stores/agent'
import type { CaptureKind } from '@/stores/capture'
import { computed, reactive, ref, toRef } from 'vue'
import { SCREEN_CAPTURE_PERMISSION } from '@/agent/skills/screen'
import { isTauri } from '@/composables/desktop'
import { useAgentStore } from '@/stores/agent'
import { DEFAULT_SHORTCUTS, useCaptureStore } from '@/stores/capture'
import { useProvidersStore } from '@/stores/providers'
import ShortcutRecorder from '@/components/settings/ShortcutRecorder.vue'

const agentStore = useAgentStore()
const captureStore = useCaptureStore()
const providersStore = useProvidersStore()

// ===== 划词 / 截图快捷键 =====

const CAPTURE_ITEMS: { kind: CaptureKind, label: string, desc: string, skill: string }[] = [
  {
    kind: 'selection',
    label: '划词快捷键',
    desc: '在任意应用中选中文字后按下快捷键，鼠标旁会弹出工具栏，可以翻译、解释、总结、润色或分析代码',
    skill: '文字处理',
  },
  {
    kind: 'screenshot',
    label: '截图快捷键',
    desc: '按下后框选屏幕区域，可以解释图片、提取或翻译文字、分析报错',
    skill: '图片理解',
  },
]

// 录制快捷键时的提示（如缺少修饰键）
const recordHint = ref<Partial<Record<CaptureKind, string>>>({})

// 只用 Alt 作修饰键时，松开 Alt 可能激活应用菜单栏导致复制失败
function isAltOnly(shortcut: string) {
  const parts = shortcut.split('+')
  return parts.includes('Alt') && !parts.includes('Ctrl') && !parts.includes('Super')
}

// ===== 单独指定的模型：意图识别、图片理解 =====

const llmProviders = computed(() => providersStore.getLLMProviders())

/** 选择某个 provider 的某个模型（为 null 时跟随对话模型），返回供表单绑定的字段 */
function useModelChoice(choice: Ref<ModelChoice | null>) {
  const providerId = computed({
    get: () => choice.value?.providerId ?? '',
    set: (id: string) => {
      const provider = id ? providersStore.getProviderById(id) : undefined
      choice.value = provider ? { providerId: provider.id, modelId: provider.selectedModelId } : null
    },
  })
  const modelId = computed({
    get: () => choice.value?.modelId ?? '',
    set: (id: string) => {
      if (choice.value) choice.value = { ...choice.value, modelId: id.trim() }
    },
  })
  // 所选 provider 的模型列表，用于输入时提示
  const models = computed(() => providersStore.getProviderById(providerId.value)?.models ?? [])
  // 已配置的模型对应的 provider 被删除时提示
  const providerMissing = computed(() => !!choice.value && !providersStore.getProviderById(choice.value.providerId))
  // reactive 会自动解开其中的 ref，模板中可以直接 v-model
  return reactive({ selected: computed(() => !!choice.value), providerId, modelId, models, providerMissing })
}

const routerChoice = useModelChoice(toRef(agentStore, 'routerModel'))
const visionChoice = useModelChoice(toRef(agentStore, 'visionModel'))
const audioChoice = useModelChoice(toRef(agentStore, 'audioModel'))

// 查看屏幕前是否每次询问（用户在授权卡片上选择「始终允许」后为 false）
const askBeforeScreenCapture = computed({
  get: () => !agentStore.isAlwaysAllowed(SCREEN_CAPTURE_PERMISSION),
  set: (ask: boolean) => agentStore.setAlwaysAllowed(SCREEN_CAPTURE_PERMISSION, !ask),
})
</script>

<template>
  <div class="scene-setting">
    <section class="tile">
      <header class="tile-head">
        <span class="tile-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
          </svg>
        </span>
        <span class="tile-title">Agent</span>
      </header>

      <label class="toggle-setting">
        <span class="setting-label">
          <span>启用技能</span>
          <span class="setting-desc">每条消息会先判断是闲聊还是任务，是任务时调用技能完成请求，再以角色口吻回复。关闭后直接闲聊，回复更快</span>
        </span>
        <span class="switch">
          <input v-model="agentStore.enabled" type="checkbox" />
          <span class="switch-track" />
        </span>
      </label>

      <div class="setting" :class="{ disabled: !agentStore.enabled }">
        <div class="setting-label">
          <span>意图识别模型</span>
          <span class="setting-desc">每条消息都会先用它判断是闲聊还是任务，只输出一个很短的结果，建议选择便宜快速的小模型（如各家的 mini、flash、turbo 版本）。需要哪些技能由对话模型在执行时决定</span>
        </div>
        <div class="model-row">
          <select v-model="routerChoice.providerId" class="field" :disabled="!agentStore.enabled">
            <option value="">跟随对话模型</option>
            <option v-for="provider in llmProviders" :key="provider.id" :value="provider.id">{{ provider.name }}</option>
          </select>
          <template v-if="routerChoice.selected && !routerChoice.providerMissing">
            <input v-model.lazy="routerChoice.modelId" class="field" list="router-models" placeholder="模型 ID" :disabled="!agentStore.enabled" />
            <datalist id="router-models">
              <option v-for="model in routerChoice.models" :key="model.id" :value="model.id">{{ model.name }}</option>
            </datalist>
          </template>
        </div>
        <span v-if="routerChoice.providerMissing" class="setting-desc warn">之前选择的 Provider 已被删除，当前使用对话模型</span>
      </div>
    </section>

    <section class="tile" :class="{ disabled: !agentStore.enabled }">
      <header class="tile-head">
        <span class="tile-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="3" width="7" height="7" rx="1.5" />
            <rect x="14" y="3" width="7" height="7" rx="1.5" />
            <rect x="3" y="14" width="7" height="7" rx="1.5" />
            <rect x="14" y="14" width="7" height="7" rx="1.5" />
          </svg>
        </span>
        <span class="tile-title">技能</span>
      </header>

      <label v-for="skill in agentStore.skills" :key="skill.id" class="toggle-setting">
        <span class="setting-label">
          <span>{{ skill.name }}</span>
          <span class="setting-desc">{{ skill.description }}</span>
        </span>
        <span class="switch">
          <input
            type="checkbox"
            :checked="agentStore.isSkillEnabled(skill.id)"
            :disabled="!agentStore.enabled"
            @change="agentStore.setSkillEnabled(skill.id, ($event.target as HTMLInputElement).checked)"
          />
          <span class="switch-track" />
        </span>
      </label>
    </section>

    <section class="tile">
      <header class="tile-head">
        <span class="tile-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7V5h16v2M9 19h6M12 5v14" />
          </svg>
        </span>
        <span class="tile-title">划词与截图</span>
      </header>

      <div v-for="item in CAPTURE_ITEMS" :key="item.kind" class="setting" :class="{ disabled: !captureStore.active[item.kind] }">
        <div class="setting-label">
          <span>{{ item.label }}</span>
          <span class="setting-desc">{{ item.desc }}</span>
        </div>
        <ShortcutRecorder
          v-model="captureStore.shortcuts[item.kind]"
          :default-value="DEFAULT_SHORTCUTS[item.kind]"
          :disabled="!captureStore.active[item.kind]"
          @hint="recordHint[item.kind] = $event"
        />
        <span v-if="recordHint[item.kind]" class="setting-desc warn">{{ recordHint[item.kind] }}</span>
        <span v-else-if="!isTauri" class="setting-desc warn">需要在桌面应用中使用，浏览器中可以直接把文字或图片发给桌宠处理</span>
        <span v-else-if="!captureStore.active[item.kind]" class="setting-desc">启用 Agent 与「{{ item.skill }}」技能后生效</span>
        <span v-else-if="captureStore.shortcutErrors[item.kind]" class="setting-desc warn">{{ captureStore.shortcutErrors[item.kind] }}</span>
        <span v-else-if="item.kind === 'selection' && isAltOnly(captureStore.shortcuts[item.kind])" class="setting-desc warn">
          只用 Alt 作修饰键时，部分应用会在松开 Alt 时激活菜单栏，可能导致取词失败，建议搭配 Ctrl
        </span>
        <span v-else class="setting-desc ok">快捷键已生效</span>
      </div>
    </section>

    <section class="tile" :class="{ disabled: !agentStore.isSkillEnabled('image') }">
      <header class="tile-head">
        <span class="tile-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="3" />
            <circle cx="9" cy="10" r="2" />
            <path d="m21 16-5-5-9 9" />
          </svg>
        </span>
        <span class="tile-title">图片理解</span>
      </header>

      <div class="setting">
        <div class="setting-label">
          <span>识图模型</span>
          <span class="setting-desc">理解图片需要支持视觉输入的模型（如 GPT-4o、Claude、Gemini）。对话模型不支持图片时（如 DeepSeek），在这里单独指定一个</span>
        </div>
        <div class="model-row">
          <select v-model="visionChoice.providerId" class="field">
            <option value="">跟随对话模型</option>
            <option v-for="provider in llmProviders" :key="provider.id" :value="provider.id">{{ provider.name }}</option>
          </select>
          <template v-if="visionChoice.selected && !visionChoice.providerMissing">
            <input v-model.lazy="visionChoice.modelId" class="field" list="vision-models" placeholder="模型 ID" />
            <datalist id="vision-models">
              <option v-for="model in visionChoice.models" :key="model.id" :value="model.id">{{ model.name }}</option>
            </datalist>
          </template>
        </div>
        <span v-if="visionChoice.providerMissing" class="setting-desc warn">之前选择的 Provider 已被删除，当前使用对话模型</span>
      </div>
    </section>

    <section class="tile" :class="{ disabled: !agentStore.isSkillEnabled('audio') }">
      <header class="tile-head">
        <span class="tile-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
          </svg>
        </span>
        <span class="tile-title">音频理解</span>
      </header>

      <div class="setting">
        <div class="setting-label">
          <span>听声音的模型</span>
          <span class="setting-desc">转录与总结说话内容使用语音识别服务（Provider 中的语音识别）和对话模型；分析声音本身（音乐、环境声、语气情绪）需要能接收音频的模型（如 Gemini、gpt-4o-audio、Qwen-Omni），对话模型不支持时在这里单独指定一个</span>
        </div>
        <div class="model-row">
          <select v-model="audioChoice.providerId" class="field">
            <option value="">跟随对话模型</option>
            <option v-for="provider in llmProviders" :key="provider.id" :value="provider.id">{{ provider.name }}</option>
          </select>
          <template v-if="audioChoice.selected && !audioChoice.providerMissing">
            <input v-model.lazy="audioChoice.modelId" class="field" list="audio-models" placeholder="模型 ID" />
            <datalist id="audio-models">
              <option v-for="model in audioChoice.models" :key="model.id" :value="model.id">{{ model.name }}</option>
            </datalist>
          </template>
        </div>
        <span v-if="audioChoice.providerMissing" class="setting-desc warn">之前选择的 Provider 已被删除，当前使用对话模型</span>
      </div>
    </section>

    <section class="tile">
      <header class="tile-head">
        <span class="tile-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
        </span>
        <span class="tile-title">授权</span>
      </header>

      <label class="toggle-setting">
        <span class="setting-label">
          <span>查看屏幕前询问</span>
          <span class="setting-desc">「看屏幕」技能需要截取你当前使用的窗口并发送给识图模型。开启时每次都会先请求你的授权；在授权卡片上选择「始终允许」后会自动关闭</span>
        </span>
        <span class="switch">
          <input v-model="askBeforeScreenCapture" type="checkbox" />
          <span class="switch-track" />
        </span>
      </label>
    </section>
  </div>
</template>

<style scoped src="../../css/settings/SceneSetting.css"></style>
<style scoped>
.tile.disabled .toggle-setting,
.tile.disabled .setting,
.setting.disabled {
  opacity: 0.55;
}

.tile.disabled .toggle-setting {
  cursor: default;
}

.model-row {
  display: flex;
  gap: 10px;
  align-items: center;
}

.field {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  font: inherit;
  font-size: 13px;
  color: #fff;
  background: rgb(0 0 0 / 28%);
  border: 1px solid rgb(255 255 255 / 12%);
  border-radius: 10px;
  outline: none;
  transition: border-color 0.2s;
}

.field:focus {
  border-color: var(--mint);
}

.field option {
  color: #fff;
  background: #1e1e22;
}

</style>
