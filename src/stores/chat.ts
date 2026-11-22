import type { LanguageModel, ModelMessage } from 'ai'
import type { AgentEvent, AgentResult, DirectToolCall, ToolDisplay } from '@/agent'
import type { Provider } from '@/stores/providers'
import type { DueReminder } from '@/stores/reminders'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { useLocalStorage } from '@vueuse/core'
import { streamText } from 'ai'
import { defineStore } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import { buildAgentContextPrompt, buildEventMessage, runAgent } from '@/agent'
import { attachQuote, MAX_TEXT_LENGTH } from '@/agent/skills/selection'
import { formatDateTime, truncate } from '@/agent/utils'
import { EMOTION_TAG_REGEX_GLOBAL } from '@/composables/queues'
import { useAgentStore } from '@/stores/agent'
import { usePersonaStore } from '@/stores/persona'
import { useProvidersStore } from '@/stores/providers'
import { useRemindersStore } from '@/stores/reminders'

// 本地持久化的对话消息（结构子集，调用 AI SDK 时再断言为 ModelMessage）
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  // 不在界面上展示的消息，如触发桌宠主动说话的系统事件
  hidden?: boolean
  // assistant 消息：生成该回复时使用的技能 id
  skills?: string[]
  // assistant 消息：技能产出的、需要完整展示的结果卡片（如译文）
  displays?: ToolDisplay[]
  // user 消息：附带的划词内容
  quote?: string
}

export interface SendMessageOptions {
  // 附带的划词内容
  quote?: string
  // 意图明确时直接调用指定工具，跳过意图识别（如划词工具栏上的按钮）
  directCall?: DirectToolCall
}

// 一轮回复的触发方式：用户发言，或系统事件（如提醒到时）
type Turn =
  | { type: 'user', content: string } & SendMessageOptions
  | { type: 'event', content: string }

// 较早的划词内容与结果卡片在请求中截断到的长度，节省上下文
const HISTORY_ATTACHMENT_LENGTH = 1000

// 转换为请求 LLM 的消息：把划词内容与已展示的结果卡片拼接到消息正文中。
// 最近一次划词保留全文（追问时工具会从中读取原文），更早的则截断
function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
  let latestQuoteIndex = -1
  messages.forEach((message, index) => {
    if (message.quote) latestQuoteIndex = index
  })

  return messages.flatMap((message, index): ModelMessage[] => {
    if (message.role === 'system') return []

    if (message.role === 'user') {
      const content = message.quote
        ? attachQuote(message.content, index === latestQuoteIndex ? message.quote : truncate(message.quote, HISTORY_ATTACHMENT_LENGTH))
        : message.content
      return [{ role: 'user', content }]
    }

    const cards = (message.displays ?? [])
      .map((display) => `【已展示给用户的「${display.title}」】\n${truncate(display.content, HISTORY_ATTACHMENT_LENGTH)}`)
    return [{ role: 'assistant', content: [message.content, ...cards].filter(Boolean).join('\n\n') }]
  })
}

// 一个会话，包含其自身的消息历史
export interface ChatSession {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
}

function createSessionId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `session-${Math.random().toString(36).slice(2)}`
}

// 根据 provider 配置的协议类型，创建对应的 AI SDK 语言模型实例
function resolveLanguageModel(provider: Provider): LanguageModel {
  const { apiKey, baseUrl, protocol } = provider
  const modelId = provider.selectedModelId

  switch (protocol) {
    case 'openai':
      // 使用 chat() 对应 Chat Completions 协议，兼容大多数第三方 OpenAI 兼容平台
      return createOpenAI({ apiKey, baseURL: baseUrl }).chat(modelId)
    case 'anthropic':
      return createAnthropic({ apiKey, baseURL: baseUrl })(modelId)
    case 'google':
      return createGoogleGenerativeAI({ apiKey, baseURL: baseUrl })(modelId)
    default:
      throw new Error(`协议 ${protocol} 暂不支持对话`)
  }
}

export const useChatStore = defineStore('chat', () => {
  const providersStore = useProvidersStore()
  const personaStore = usePersonaStore()
  const agentStore = useAgentStore()
  const remindersStore = useRemindersStore()

  function createSession(title = '新对话'): ChatSession {
    const now = Date.now()
    return { id: createSessionId(), title, messages: [{ role: 'system', content: personaStore.systemPrompt }], createdAt: now, updatedAt: now }
  }

  // 所有会话
  const sessions = useLocalStorage<ChatSession[]>('chat/sessions', [])
  // 当前选中的会话 id
  const currentSessionId = useLocalStorage<string>('chat/currentSessionId', '')

  // 是否正在等待/接收流式响应
  const isStreaming = ref(false)
  // Agent 当前进度的描述（如「正在使用技能：天气」），为空表示没有在使用技能
  const agentStatus = ref('')

  // 发送消息时的钩子函数，用于在流式响应的不同阶段进行处理
  const onStartHooks = ref<(() => Promise<void>)[]>([])
  const onFirstChunkArrivedHooks = ref<(() => Promise<void>)[]>([])
  const onChunkHooks = ref<((delta: string) => Promise<void>)[]>([])
  const onFinishHooks = ref<((text: string) => Promise<void>)[]>([])
  const onErrorHooks = ref<((error: unknown) => Promise<void>)[]>([])

  // 当前选中的会话
  const currentSession = ref<ChatSession | null>(sessions.value.find((s) => s.id === currentSessionId.value) ?? null)
  // 当前选中会话的消息列表
  const messages = computed(() => currentSession.value?.messages ?? [])
  // 用于界面展示的消息列表，过滤掉隐藏的系统提示词
  const visibleMessages = computed(() => messages.value.filter((message) => message.role !== 'system' && !message.hidden))

  // 将指定会话移动到最前面
  function moveSessionToFront(id: string) {
    const index = sessions.value.findIndex((s) => s.id === id)
    if (index <= 0) return // 已在首位或未找到
    const session = sessions.value.splice(index, 1)[0]
    if (!session) return
    sessions.value.unshift(session)
  }

  // 获取当前会话，若不存在则新建一个并选中
  function ensureCurrentSession(): ChatSession {
    const existing = currentSession.value
    if (existing) return existing

    const session = createSession()
    sessions.value.unshift(session)
    currentSessionId.value = session.id
    currentSession.value = sessions.value[0]!
    return currentSession.value
  }

  // 新建一个会话并选中，返回其 id
  function createNewSession(title?: string): string {
    const session = createSession(title)
    sessions.value.unshift(session)
    currentSessionId.value = session.id
    currentSession.value = sessions.value[0]!
    return session.id
  }

  // 切换当前选中的会话
  function switchSession(id: string) {
    if (!sessions.value.some((s) => s.id === id)) return
    currentSessionId.value = id
  }

  // 删除会话，若删除的是当前会话则自动切换到其他会话
  function removeSession(id: string) {
    const index = sessions.value.findIndex((s) => s.id === id)
    if (index === -1) return

    sessions.value.splice(index, 1)

    if (currentSessionId.value === id) {
      currentSessionId.value = sessions.value[0]?.id ?? ''
    }
  }

  // 重命名会话
  function renameSession(id: string, title: string) {
    const session = sessions.value.find((s) => s.id === id)
    if (!session) return
    session.title = title
  }

  // 同一时间只生成一条回复：用户消息与系统事件（如提醒到时）按顺序排队执行
  let pendingReply: Promise<void> = Promise.resolve()
  function enqueueReply(turn: Turn): Promise<void> {
    const task = pendingReply.then(() => reply(turn))
    pendingReply = task.catch(() => {})
    return task
  }

  // 发送一条用户消息，并以流式方式接收模型回复，期间通过 hooks 回调通知调用方
  function sendMessage(content: string, options: SendMessageOptions = {}) {
    return enqueueReply({ type: 'user', content, ...options })
  }

  // 让桌宠针对一个系统事件主动开口说话，event 为对事件的描述
  function speakProactively(event: string) {
    return enqueueReply({ type: 'event', content: event })
  }

  // 将 Agent 事件转换为界面上展示的进度描述
  function describeAgentEvent(event: AgentEvent): string {
    switch (event.type) {
      case 'routing':
        return ''
      case 'routed':
        return event.skills.length ? `正在使用技能：${event.skills.map((skill) => skill.name).join('、')}` : ''
      default:
        return agentStatus.value
    }
  }

  // 生成一轮回复：
  // 1. 意图识别 + 工具执行（仅用户发言时，由 Agent 完成）；
  // 2. 将工具执行结果附加到人设提示词之后，由 LLM 以角色口吻流式生成最终回复
  async function reply(turn: Turn) {
    const provider = providersStore.getCurrentLLMProvider()
    if (!provider) {
      onErrorHooks.value.forEach(hook => hook(new Error('未配置可用的 LLM Provider')))
      return
    }
    onStartHooks.value.forEach(hook => hook())

    const session = ensureCurrentSession()

    if (turn.type === 'user') {
      const quote = turn.quote?.trim()
      session.messages.push({ role: 'user', content: turn.content, ...(quote ? { quote: quote.slice(0, MAX_TEXT_LENGTH) } : {}) })
      if (session.title === '新对话' && !session.messages.some((m) => m.role === 'assistant')) {
        session.title = turn.content.slice(0, 20)
      }
    }
    else {
      // 系统事件以隐藏的用户消息告知 LLM，同时保持 user / assistant 交替，兼容各服务商
      session.messages.push({ role: 'user', content: buildEventMessage(turn.content), hidden: true })
    }
    session.updatedAt = Date.now()
    moveSessionToFront(session.id)
    isStreaming.value = true

    // 请求消息不包含下面新增的占位回复；系统提示词单独传入，以便附加技能执行结果
    const systemPrompt = session.messages.find((m) => m.role === 'system')?.content ?? personaStore.systemPrompt
    const dialog = toModelMessages(session.messages)

    // 占位的 assistant 消息，随流式响应实时更新其内容
    session.messages.push({ role: 'assistant', content: '' })
    const assistantIndex = session.messages.length - 1

    let fullText = ''
    let isFirstChunk = true
    try {
      const model = resolveLanguageModel(provider)

      // 阶段一、二：意图识别与工具执行，不需要技能时返回 null
      let agentResult: AgentResult | null = null
      if (turn.type === 'user') {
        agentResult = await runAgent({
          model,
          messages: dialog,
          skills: agentStore.activeSkills,
          directCall: turn.directCall,
          onEvent: (event) => { agentStatus.value = describeAgentEvent(event) },
        })
        if (agentResult) {
          const message = session.messages[assistantIndex]!
          message.skills = agentResult.skills.map((skill) => skill.id)
          if (agentResult.displays.length) message.displays = agentResult.displays
        }
      }

      // 阶段三：以角色口吻润色执行结果（或直接闲聊）
      const result = streamText({
        model,
        system: agentResult ? `${systemPrompt}\n\n${buildAgentContextPrompt(agentResult)}` : systemPrompt,
        messages: dialog,
      })

      for await (const delta of result.textStream) {
        if (isFirstChunk) {
          isFirstChunk = false
          agentStatus.value = ''
          onFirstChunkArrivedHooks.value.forEach(hook => hook())
        }

        fullText += delta
        // 过滤掉情绪标记，使其不显示在聊天界面中
        session.messages[assistantIndex]!.content = fullText.replace(EMOTION_TAG_REGEX_GLOBAL, '')
        session.updatedAt = Date.now()
        onChunkHooks.value.forEach(hook => hook(delta))
      }

      onFinishHooks.value.forEach(hook => hook(fullText))
    }
    catch (error) {
      // 未产生任何内容（文字与结果卡片）时移除空的占位回复
      if (!fullText && !session.messages[assistantIndex]?.displays) {
        session.messages.splice(assistantIndex, 1)
      }
      onErrorHooks.value.forEach(hook => hook(error))
    }
    finally {
      agentStatus.value = ''
      isStreaming.value = false
    }
  }

  // 提醒到时，让桌宠主动提醒用户
  remindersStore.onDue(async (reminder: DueReminder) => {
    const due = formatDateTime(new Date(reminder.dueAt))
    const event = reminder.late
      ? `用户设定在 ${due} 的提醒「${reminder.message}」因为应用当时没有运行而错过了，现在才补上。请提醒用户，并说明晚了。`
      : `用户之前让你设定的提醒时间到了，提醒内容是「${reminder.message}」。请提醒用户。`
    speakProactively(event)
  })

  // 清空当前会话的对话历史，保留隐藏的系统提示词
  function clearMessages() {
    const session = currentSession.value
    if (!session) return
    session.messages = [{ role: 'system', content: personaStore.systemPrompt }]
    session.updatedAt = Date.now()
    moveSessionToFront(session.id)
  }

  // 添加发送消息时的钩子函数
  function onStart(hook: () => Promise<void>) {
    onStartHooks.value.push(hook)
  }

  function onFirstChunkArrived(hook: () => Promise<void>) {
    onFirstChunkArrivedHooks.value.push(hook)
  }

  function onChunk(hook: (delta: string) => Promise<void>) {
    onChunkHooks.value.push(hook)
  }

  function onFinish(hook: (text: string) => Promise<void>) {
    onFinishHooks.value.push(hook)
  }

  function onError(hook: (error: unknown) => Promise<void>) {
    onErrorHooks.value.push(hook)
  }

  onMounted(() => {
    sessions.value.sort((a, b) => b.updatedAt - a.updatedAt)
  })

  watch(currentSessionId, (newId) => {
    currentSession.value = sessions.value.find((s) => s.id === newId) ?? null
  })

  return {
    sessions,
    currentSessionId,
    currentSession,
    messages,
    visibleMessages,
    isStreaming,
    agentStatus,

    createNewSession,
    switchSession,
    removeSession,
    renameSession,

    sendMessage,
    speakProactively,
    onStart,
    onFirstChunkArrived,
    onChunk,
    onFinish,
    onError,
    clearMessages,
  }
})
