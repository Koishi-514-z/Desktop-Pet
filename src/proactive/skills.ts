import type { Skill } from '@/agent/types'

/**
 * 主动交互时可以使用的技能与工具：只能读取信息（查天气、看待办、翻记忆、搜网页），
 * 不能修改任何东西，也不能截屏、读文件——用户没有提出请求，也不一定在看着。
 */
export const PROACTIVE_TOOLS: Record<string, readonly string[] | 'all'> = {
  datetime: 'all',
  weather: ['get_weather'],
  tasks: ['list_tasks'],
  memory: ['list_memories', 'search_memories'],
  web: ['web_search', 'read_webpage'],
}

/** 从启用的技能中挑出主动交互可以使用的，并只保留其中读取信息的工具 */
export function proactiveSkills(skills: readonly Skill[]): Skill[] {
  return skills.flatMap((skill): Skill[] => {
    const allowed = PROACTIVE_TOOLS[skill.id]
    if (!allowed) return []
    const tools = allowed === 'all' ? skill.tools : Object.fromEntries(Object.entries(skill.tools).filter(([name]) => allowed.includes(name)))
    if (Object.keys(tools).length === 0) return []
    const names = Object.keys(tools).join('、')
    return [{
      ...skill,
      tools,
      // 使用说明中可能提到修改类的工具，说明这次只能用哪些
      instructions: () => {
        const base = typeof skill.instructions === 'function' ? skill.instructions() : skill.instructions
        return `${base.trim()}\n- 这次是主动交互，只能使用读取信息的工具：${names}。`
      },
    }]
  })
}
