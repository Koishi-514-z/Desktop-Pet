import type { Skill } from '@/agent/types'
import { markRaw } from 'vue'
import { datetimeSkill } from '@/agent/skills/datetime'
import { filesSkill } from '@/agent/skills/files'
import { imageSkill } from '@/agent/skills/image'
import { memorySkill } from '@/agent/skills/memory'
import { screenSkill } from '@/agent/skills/screen'
import { selectionSkill } from '@/agent/skills/selection'
import { tasksSkill } from '@/agent/skills/tasks'
import { weatherSkill } from '@/agent/skills/weather'
import { webSkill } from '@/agent/skills/web'

// 所有内置技能。新增技能时在这里注册即可。
// markRaw 避免 Vue 将工具（含 zod schema）转换为响应式代理
export const builtinSkills: readonly Skill[] = [
  datetimeSkill,
  weatherSkill,
  selectionSkill,
  imageSkill,
  screenSkill,
  memorySkill,
  tasksSkill,
  filesSkill,
  webSkill,
].map((skill) => markRaw(skill))
