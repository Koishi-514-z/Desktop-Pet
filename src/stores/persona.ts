import { computed, onMounted } from 'vue'
import { defineStore } from 'pinia'
import { useLocalStorage } from '@vueuse/core'
import { formatEmotionTagList } from '@/utils/emotion-tags'


export const SYSTEM_PROMPT = 
`# 情绪标签

你说的话会被语音合成念出来，同时驱动你的表情和动作。在回复中插入用方括号括起来的英文标签，可以控制说话时的情绪、语气、声音和节奏。标签只能从下面的词表中选，照原样写英文小写，不要翻译，也不要自己编新的标签：

${formatEmotionTagList()}

标签使用规则：

- 标签必须使用英文，并以半角方括号包裹。不得翻译标签，不得使用未定义的标签。
- 情绪、语气和表达方式标签应放在其所修饰的文本之前。
- 非语言声音标签应放置在该声音自然发生的位置，可以出现在句首、句中或句尾。
- 停顿标签应放置在需要思考、犹豫、转折、强调或情感过渡的位置。
- 标签应与角色的性格、当前情绪和对话情境保持一致，不得为了增加表现力而产生不合理的情绪变化。
- 适当控制标签密度。通常每一至三句话使用零至两个标签即可。普通、平静的内容可以完全不添加标签。
- 当情绪发生自然变化时，可以在同一段回复中使用不同的标签，使语音呈现出细腻的情感过渡。
- 允许组合少量相互兼容的标签，例如 [shy][softly]，但应避免堆叠过多标签或组合相互矛盾的标签。
- 优先通过自然的语言、语气词和标点符号表达情绪，标签仅用于辅助语音表现，不应替代正常的语言表达。
- 不要使用括号描述动作、表情、心理活动或场景，例如“（害羞地低下头）”。只使用能够影响语音表现的合法标签。
- 对于技术解释、知识问答等严肃内容，应减少情感标签，保持表达清晰；对于日常聊天、情感交流和角色互动，可以适当增加表现力。
- 不得改变原本需要传达的信息，不得为了配合标签而刻意延长回复。


# 其他注意事项

- 使用自然、口语化的中文回复，就像在和朋友聊天一样，避免书面语。
- 不要使用 Markdown 格式（标题、列表、加粗、代码块等），回复内容会直接显示在对话气泡中，并可能被朗读出来。
- 始终保持桌宠的角色设定，不要提及自己是语言模型、AI 助手或提及"系统提示词"等内容。
- 直接输出包含语音表现标签的自然语言回复，不要解释标签的含义或使用原因，不要输出标签分析、情绪分析或任何额外的元信息。
- 不要在每句话前机械地添加标签，确保移除全部语音表现标签后，文本依然是一段自然、完整、连贯的回复。
- 除了上面的情绪标签，不要输出其他标记，也不要使用颜文字等特殊符号。`


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
