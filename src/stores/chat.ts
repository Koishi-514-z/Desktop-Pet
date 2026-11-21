import type { LanguageModel, ModelMessage } from 'ai'
import type { Provider } from '@/stores/providers'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { useLocalStorage } from '@vueuse/core'
import { streamText } from 'ai'
import { defineStore } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import { EMOTION_TAG_REGEX_GLOBAL } from '@/composables/queues'
import { usePersonaStore } from '@/stores/persona'
import { useProvidersStore } from '@/stores/providers'

// 本地持久化的对话消息（结构子集，调用 AI SDK 时再断言为 ModelMessage）
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
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
  const visibleMessages = computed(() => messages.value.filter((message) => message.role !== 'system'))

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

  // 发送一条用户消息，并以流式方式接收模型回复，期间通过 hooks 回调通知调用方
  async function sendMessage(content: string) {
    const provider = providersStore.getCurrentLLMProvider()
    if (!provider) {
      onErrorHooks.value.forEach(hook => hook(new Error('未配置可用的 LLM Provider')))
      return
    }
    onStartHooks.value.forEach(hook => hook())

    const session = ensureCurrentSession()

    session.messages.push({ role: 'user', content })
    if (session.title === '新对话' && session.messages.length === 2) {
      session.title = content.slice(0, 20)
    }
    session.updatedAt = Date.now()
    moveSessionToFront(session.id)
    isStreaming.value = true

    // 请求消息不包含下面新增的占位回复
    const requestMessages = session.messages.map((message) => ({ ...message })) as ModelMessage[]

    // 占位的 assistant 消息，随流式响应实时更新其内容
    session.messages.push({ role: 'assistant', content: '' })
    const assistantIndex = session.messages.length - 1

    let fullText = ''
    let isFirstChunk = true
    try {
      const model = resolveLanguageModel(provider)
      const result = streamText({
        model,
        messages: requestMessages,
      })

      for await (const delta of result.textStream) {
        if (isFirstChunk) {
          isFirstChunk = false
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
      // 未产生任何内容时移除空的占位回复
      if (!fullText) {
        session.messages.splice(assistantIndex, 1)
      }
      onErrorHooks.value.forEach(hook => hook(error))
    }
    finally {
      console.log(sessions.value)
      isStreaming.value = false
    }
  }

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

    createNewSession,
    switchSession,
    removeSession,
    renameSession,

    sendMessage,
    onStart,
    onFirstChunkArrived,
    onChunk,
    onFinish,
    onError,
    clearMessages,
  }
})
