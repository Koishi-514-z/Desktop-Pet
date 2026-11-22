import type { Skill } from '@/agent/types'
import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed } from 'vue'
import { builtinSkills } from '@/agent/skills'

// Agent 设置：总开关与各技能的启用状态
export const useAgentStore = defineStore('agent', () => {
  // 是否启用 Agent；关闭后每条消息都直接由 LLM 闲聊回复，省去一次意图识别请求
  const enabled = useLocalStorage('settings/agent/enabled', true)
  // 记录被禁用的技能，这样新增的技能默认是启用的
  const disabledSkillIds = useLocalStorage<string[]>('settings/agent/disabledSkillIds', [])

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

  return {
    enabled,
    disabledSkillIds,
    skills,
    activeSkills,
    isSkillEnabled,
    setSkillEnabled,
    getSkillById,
  }
})
