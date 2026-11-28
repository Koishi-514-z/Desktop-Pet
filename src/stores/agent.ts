import type { LanguageModel } from 'ai'
import type { Skill } from '@/agent/types'
import { StorageSerializers, useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed } from 'vue'
import { builtinSkills } from '@/agent/skills'
import { useProvidersStore } from '@/stores/providers'
import { resolveLanguageModel } from '@/utils/llm'

// 指定使用某个 provider 的某个模型
export interface ModelChoice {
  providerId: string
  modelId: string
}

// Agent 设置：总开关与各技能的启用状态
export const useAgentStore = defineStore('agent', () => {
  // 是否启用 Agent；关闭后每条消息都直接由 LLM 闲聊回复，省去一次意图识别请求
  const enabled = useLocalStorage('settings/agent/enabled', true)
  // 记录被禁用的技能，这样新增的技能默认是启用的
  const disabledSkillIds = useLocalStorage<string[]>('settings/agent/disabledSkillIds', [])
  // 图片理解使用的模型；为 null 时与对话使用同一个模型
  const visionModel = useLocalStorage<ModelChoice | null>('settings/agent/visionModel', null, { serializer: StorageSerializers.object })
  // 音频理解中「听声音」（分析音乐、环境声、语气等）使用的模型，需要能接收音频输入；为 null 时与对话使用同一个模型
  const audioModel = useLocalStorage<ModelChoice | null>('settings/agent/audioModel', null, { serializer: StorageSerializers.object })
  // 意图识别（区分闲聊与任务）使用的模型，只需要输出很短的判断结果，适合便宜快速的小模型；为 null 时与对话使用同一个模型
  const routerModel = useLocalStorage<ModelChoice | null>('settings/agent/routerModel', null, { serializer: StorageSerializers.object })
  // 用户选择了「始终允许」的权限类型（如 screen-capture），这些请求不再询问
  const alwaysAllowedPermissions = useLocalStorage<string[]>('settings/agent/alwaysAllowedPermissions', [])

  const skills = builtinSkills

  // 本次对话可用的技能
  const activeSkills = computed<Skill[]>(() =>
    enabled.value ? skills.filter((skill) => !disabledSkillIds.value.includes(skill.id)) : [],
  )

  function isSkillEnabled(id: string) {
    return !disabledSkillIds.value.includes(id)
  }

  function setSkillEnabled(id: string, value: boolean) {
    const rest = disabledSkillIds.value.filter((skillId) => skillId !== id)
    disabledSkillIds.value = value ? rest : [...rest, id]
  }

  function getSkillById(id: string) {
    return skills.find((skill) => skill.id === id)
  }

  function isAlwaysAllowed(kind: string) {
    return alwaysAllowedPermissions.value.includes(kind)
  }

  function setAlwaysAllowed(kind: string, value: boolean) {
    const rest = alwaysAllowedPermissions.value.filter((k) => k !== kind)
    alwaysAllowedPermissions.value = value ? [...rest, kind] : rest
  }

  // 解析单独指定的模型，未配置或配置失效时返回 undefined（即使用对话模型）
  function resolveModelChoice(choice: ModelChoice | null): LanguageModel | undefined {
    if (!choice) return undefined
    const provider = useProvidersStore().getProviderById(choice.providerId)
    if (!provider || provider.category !== 'llm') return undefined
    return resolveLanguageModel(provider, choice.modelId || provider.selectedModelId)
  }

  // 图片理解使用的模型
  function resolveVisionModel(): LanguageModel | undefined {
    return resolveModelChoice(visionModel.value)
  }

  // 「听声音」使用的模型
  function resolveAudioModel(): LanguageModel | undefined {
    return resolveModelChoice(audioModel.value)
  }

  // 意图识别使用的模型
  function resolveRouterModel(): LanguageModel | undefined {
    return resolveModelChoice(routerModel.value)
  }

  return {
    enabled,
    disabledSkillIds,
    visionModel,
    audioModel,
    routerModel,
    alwaysAllowedPermissions,
    skills,
    activeSkills,
    isSkillEnabled,
    setSkillEnabled,
    getSkillById,
    resolveVisionModel,
    resolveAudioModel,
    resolveRouterModel,
    isAlwaysAllowed,
    setAlwaysAllowed,
  }
})
