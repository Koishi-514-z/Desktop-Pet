import type { Skill } from '@/agent/types'
import { markRaw } from 'vue'
import { datetimeSkill } from '@/agent/skills/datetime'
import { reminderSkill } from '@/agent/skills/reminder'
import { weatherSkill } from '@/agent/skills/weather'

// 所有内置技能。新增技能时在这里注册即可。
// markRaw 避免 Vue 将工具（含 zod schema）转换为响应式代理
export const builtinSkills: readonly Skill[] = [
  datetimeSkill,
  reminderSkill,
  weatherSkill,
].map((skill) => markRaw(skill))
