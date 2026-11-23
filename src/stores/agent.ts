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

  // 解析图片理解使用的模型，未配置或配置失效时返回 undefined（即使用对话模型）
  function resolveVisionModel(): LanguageModel | undefined {
    const choice = visionModel.value
    if (!choice) return undefined
    const provider = useProvidersStore().getProviderById(choice.providerId)
    if (!provider || provider.category !== 'llm') return undefined
    return resolveLanguageModel(provider, choice.modelId || provider.selectedModelId)
  }

  return {
    enabled,
    disabledSkillIds,
    visionModel,
    skills,
    activeSkills,
    isSkillEnabled,
    setSkillEnabled,
    getSkillById,
    resolveVisionModel,
  }
})
