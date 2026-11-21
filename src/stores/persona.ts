import { computed, onMounted } from 'vue'
import { defineStore } from 'pinia'
import { useLocalStorage } from '@vueuse/core'


export const SYSTEM_PROMPT = 
`# 回复格式要求

- 使用自然、口语化的中文回复，就像在和朋友聊天一样，避免书面语和长篇大论。
- 不要使用 Markdown 格式（标题、列表、加粗、代码块等），回复内容会直接显示在对话气泡中，并可能被朗读出来。

# 情绪标签

你应当在回复文本的开头插入情绪标签，用于控制你的表情和动作。标签格式为 <emotion_name>，必须是下面词表中的一个：

- neutral：平静、日常
- happy：开心、愉快
- excited：兴奋、激动
- love：喜欢、撒娇
- shy：害羞、不好意思
- smug：得意、骄傲
- surprised：惊讶、震惊
- confused：疑惑、不解
- sad：难过、失落
- angry：生气、不满
- cry：哭泣、委屈
- sleepy：困倦、犯懒

使用规则：
- 情绪标签只能放在一段话的最开头，用于表示接下来这段话的情绪，标签后面紧跟正文内容。
- 如果某段内容情绪平稳，在开头插入一个 <neutral> 即可。
- 不要向用户解释或提及这些标签的存在。

# 其他注意事项

- 始终保持桌宠的角色设定，不要提及自己是语言模型、AI 助手或提及"系统提示词"等内容。
- 不要输出 <END/> 或任何与上述格式无关的标记，这些由程序自动处理。`


export interface Persona {
  id: string
  name: string
  personality: string
  background?: string
  speakingStyle?: string
}

function createPersonaId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `persona-${Math.random().toString(36).slice(2)}`
}

export const defaultPersonas: Persona[] = [
  {
    id: 'default',
    name: 'ATRI',
    personality: '活泼、温柔、有点小调皮，会主动关心用户的状态（工作、学习、休息等），但不会过度打扰。',
    background: '',
    speakingStyle: '',
  },
]

export const usePersonaStore = defineStore('persona', () => {
  const personas = useLocalStorage<Persona[]>('settings/persona/personas', defaultPersonas)
  const currentPersonaId = useLocalStorage<string>('settings/persona/currentPersonaId', defaultPersonas[0]!.id)

  const currentPersona = computed(() => personas.value.find((p) => p.id === currentPersonaId.value))

  function buildSystemPrompt(id: string) {
    const persona = getPersonaById(id)
    if (!persona) return SYSTEM_PROMPT

    const sections: string[] = []

    sections.push(`你是一个生活在用户电脑桌面上的桌宠，是用户的小伙伴。`)

    sections.push(`你的名字是「${persona.name}」。`)

    if (persona.personality)
      sections.push(`# 性格特点\n${persona.personality}`)

    if (persona.background)
      sections.push(`# 背景故事\n${persona.background}`)

    if (persona.speakingStyle)
      sections.push(`# 说话风格\n${persona.speakingStyle}`)

    sections.push(SYSTEM_PROMPT)

    return sections.join('\n\n')
  }

  const systemPrompt = computed(() => buildSystemPrompt(currentPersonaId.value))

  function getPersonaById(id: string) {
    return personas.value.find((p) => p.id === id)
  }

  function addPersona(persona: Persona) {
    if (!persona.id) persona.id = createPersonaId()
    personas.value.push({ ...persona })
    return persona.id
  }

  function removePersona(id: string) {
    const index = personas.value.findIndex((p) => p.id === id)
    if (index === -1) return

    personas.value.splice(index, 1)

    if (currentPersonaId.value === id)
      currentPersonaId.value = personas.value[0]?.id ?? ''
  }

  function updatePersona(id: string, patch: Partial<Omit<Persona, 'id'>>) {
    const persona = getPersonaById(id)
    if (!persona) return
    Object.assign(persona, patch)
  }

  function switchPersona(id: string) {
    if (!personas.value.some((p) => p.id === id)) return
    currentPersonaId.value = id
  }

  function isDefaultPersona(id: string) {
    return defaultPersonas.some((p) => p.id === id)
  }

  return {
    personas,
    currentPersonaId,
    currentPersona,
    systemPrompt,

    getPersonaById,
    addPersona,
    removePersona,
    updatePersona,
    switchPersona,
    isDefaultPersona,
    buildSystemPrompt,
  }
})
