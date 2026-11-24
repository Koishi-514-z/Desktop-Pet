import type { LanguageModel, ModelMessage } from 'ai'
import type { AgentEvent, AgentResult, DirectToolCall, PermissionRequest, ToolDisplay } from '@/agent'
import type { AgentTrace } from '@/agent/trace'
import type { RecalledMemory, RememberedMemory } from '@/memory/types'
import type { DueReminder } from '@/stores/reminders'
import type { ImageRef } from '@/utils/images'
import { useLocalStorage } from '@vueuse/core'
import { streamText } from 'ai'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { buildAgentContextPrompt, buildEventMessage, runAgent } from '@/agent'
import { buildToolLog } from '@/agent/compact'
import { appendToolLog } from '@/agent/prompts'
import { imageMarkers, MAX_IMAGES } from '@/agent/skills/image'
import { attachQuote, MAX_TEXT_LENGTH } from '@/agent/skills/selection'
import { applyAgentEvent, createTrace, finishTrace, hasExecution, startReply } from '@/agent/trace'
import { errorMessage, formatDateTime, truncate } from '@/agent/utils'
import { EMOTION_TAG_REGEX_GLOBAL } from '@/composables/queues'
import { useIndexedDBStorage } from '@/composables/storage'
import { useAgentStore } from '@/stores/agent'
import { usePersonaStore } from '@/stores/persona'
import { useProvidersStore } from '@/stores/providers'
import { useRemindersStore } from '@/stores/reminders'
import { useSceneStore } from '@/stores/scene'
import { useMemoryStore } from '@/stores/memory'
import { deleteImages } from '@/utils/images'
import { resolveLanguageModel } from '@/utils/llm'
import { toMemoryDialog } from '@/memory/writer'
import { createBatchId } from '@/memory/api'
import { MEMORY_SKILL_ID } from '@/agent/skills/memory'

// 本地持久化的对话消息（结构子集，调用 AI SDK 时再断言为 ModelMessage）
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  // 不在界面上展示的消息，如触发桌宠主动说话的系统事件
  hidden?: boolean
  // assistant 消息：生成该回复时从长期记忆中想起的事情
  memories?: RecalledMemory[]
  // assistant 消息：这一轮对话后记住的事情（新增或更新的记忆）
  remembered?: RememberedMemory[]
  // assistant 消息：这一轮记忆变动的批次，用于撤销
  rememberedBatch?: string
  // assistant 消息：生成该回复时使用的技能 id
  skills?: string[]
  // assistant 消息：技能产出的、需要完整展示的结果卡片（如译文）
  displays?: ToolDisplay[]
  // assistant 消息：Agent 的执行过程（意图识别、每一轮的工具调用、生成回复），普通闲聊时没有
  trace?: AgentTrace
  // assistant 消息：这一轮工具调用的紧凑记录（工具、关键参数与简短的结果），
  // 追问时交给意图识别与工具执行阶段，不交给角色扮演阶段
  toolLog?: string
  // user 消息：附带的划词内容
  quote?: string
  // user 消息：附带的图片（数据保存在 IndexedDB 中）
  images?: ImageRef[]
}

export interface SendMessageOptions {
  // 附带的划词内容
  quote?: string
  // 附带的图片，需先通过 addImage 保存
  images?: ImageRef[]
  // 意图明确时直接调用指定工具，跳过意图识别（如划词工具栏上的按钮）
  directCall?: DirectToolCall
}

// 一轮回复的触发方式：用户发言，或系统事件（如提醒到时）
type Turn =
  | { type: 'user', content: string } & SendMessageOptions
  | { type: 'event', content: string }

// 用户对授权请求的回应
export type PermissionDecision = 'deny' | 'once' | 'always'

// 正在等待用户回应的授权请求
export interface PendingPermission {
  id: string
  request: PermissionRequest
}

// 授权请求无人回应多久后视为拒绝
const PERMISSION_TIMEOUT = 2 * 60 * 1000

// 较早的划词内容与结果卡片在请求中截断到的长度，节省上下文
const HISTORY_ATTACHMENT_LENGTH = 2000
// 用第一条消息自动生成的会话标题的长度
const SESSION_TITLE_LENGTH = 40

// 转换为请求 LLM 的消息：把划词内容、图片标记与已展示的结果卡片拼接到消息正文中。
// 最近一次划词保留全文（追问时工具会从中读取原文），更早的则截断。
// 图片本身不发给对话模型（它不一定支持图片），由图片理解技能根据标记读取。
// withToolLogs：附上每轮的工具调用记录，交给 Agent（意图识别与工具执行）。角色扮演阶段不附上，
// 以免模型模仿这种格式，把记录写进回复里
function toModelMessages(messages: ChatMessage[], options: { withToolLogs?: boolean } = {}): ModelMessage[] {
  let latestQuoteIndex = -1
  messages.forEach((message, index) => {
    if (message.quote) latestQuoteIndex = index
  })

  return messages.flatMap((message, index): ModelMessage[] => {
    if (message.role === 'system') return []

    if (message.role === 'user') {
      const images = message.images ?? []
      let content = message.content || (images.length ? `（发送了 ${images.length} 张图片）` : '')
      if (message.quote) {
        content = attachQuote(content, index === latestQuoteIndex ? message.quote : truncate(message.quote, HISTORY_ATTACHMENT_LENGTH))
      }
      if (images.length) {
        content = `${content}\n\n${imageMarkers(images.map((image) => image.id))}`
      }
      return [{ role: 'user', content }]
    }

    const cards = (message.displays ?? [])
      .map((display) => `【已展示给用户的「${display.title}」】\n${truncate(display.content, HISTORY_ATTACHMENT_LENGTH)}`)
    // 回复失败、只保留了执行过程的消息没有内容，部分服务商不接受空的 assistant 消息
    const content = [message.content, ...cards].filter(Boolean).join('\n\n') || '（这次回复失败了，没有内容）'
    return [{ role: 'assistant', content: options.withToolLogs ? appendToolLog(content, message.toolLog) : content }]
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

export const useChatStore = defineStore('chat', () => {
  const providersStore = useProvidersStore()
  const personaStore = usePersonaStore()
  const agentStore = useAgentStore()
  const remindersStore = useRemindersStore()
  const memoryStore = useMemoryStore()

  function createSession(title = '新对话'): ChatSession {
    const now = Date.now()
    return { id: createSessionId(), title, messages: [{ role: 'system', content: personaStore.systemPrompt }], createdAt: now, updatedAt: now }
  }

  // 所有会话：数据较大（消息、结果卡片、执行过程），以 JSON 字符串整体保存在 IndexedDB 中，启动后异步加载。
  // 加载完成前新建的会话（如启动后立刻发了消息）放在保存的会话前面
  const { data: sessions, ready: sessionsReady } = useIndexedDBStorage<ChatSession[]>('chat/sessions', [], {
    merge: (stored, current) => [...current.filter((session) => !stored.some((s) => s.id === session.id)), ...stored],
  })
  // 当前选中的会话 id
  const currentSessionId = useLocalStorage<string>('chat/currentSessionId', '')

  // 是否正在等待/接收流式响应
  const isStreaming = ref(false)
  // Agent 当前进度的描述（如「正在使用技能：天气」），为空表示没有在使用技能
  const agentStatus = ref('')
  // 正在等待用户回应的授权请求（如截取屏幕），界面上显示为授权卡片
  const pendingPermission = ref<PendingPermission | null>(null)
  let settlePermission: ((decision: PermissionDecision) => void) | null = null

  // 发送消息时的钩子函数，用于在流式响应的不同阶段进行处理
  const onStartHooks = ref<(() => Promise<void>)[]>([])
  const onFirstChunkArrivedHooks = ref<(() => Promise<void>)[]>([])
  const onChunkHooks = ref<((delta: string) => Promise<void>)[]>([])
  const onFinishHooks = ref<((text: string) => Promise<void>)[]>([])
  const onErrorHooks = ref<((error: unknown) => Promise<void>)[]>([])

  // 当前选中的会话（会话加载完成后才能找到）
  const currentSession = ref<ChatSession | null>(null)
  sessionsReady.then(() => {
    sessions.value.sort((a, b) => b.updatedAt - a.updatedAt)
    currentSession.value = sessions.value.find((s) => s.id === currentSessionId.value) ?? null
  })
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

    const [session] = sessions.value.splice(index, 1)
    removeImagesOf(session?.messages ?? [])

    if (currentSessionId.value === id) {
      currentSessionId.value = sessions.value[0]?.id ?? ''
    }
  }

  // 删除消息中引用的图片数据
  function removeImagesOf(messages: ChatMessage[]) {
    const ids = messages.flatMap((message) => message.images?.map((image) => image.id) ?? [])
    deleteImages(ids).catch((error) => console.warn('[chat] 删除图片失败：', error))
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
        return event.decision.task ? '正在分析需要哪些技能' : ''
      case 'skills-loaded':
        return `正在使用技能：${event.skills.map((skill) => skill.name).join('、')}`
      default:
        return agentStatus.value
    }
  }

  // 技能请求授权：已设为「始终允许」的直接通过，否则打开对话面板等待用户选择
  function requestPermission(request: PermissionRequest): Promise<boolean> {
    if (agentStore.isAlwaysAllowed(request.kind)) return Promise.resolve(true)

    // 同一时间只保留一个请求，之前未回应的视为拒绝
    settlePermission?.('deny')
    useSceneStore().interactiveAreaState.visible = true

    return new Promise((resolve) => {
      const timer = setTimeout(() => settlePermission?.('deny'), PERMISSION_TIMEOUT)
      pendingPermission.value = { id: createSessionId(), request }
      settlePermission = (decision) => {
        clearTimeout(timer)
        pendingPermission.value = null
        settlePermission = null
        if (decision === 'always') agentStore.setAlwaysAllowed(request.kind, true)
        resolve(decision !== 'deny')
      }
    })
  }

  // 用户回应授权请求
  function respondPermission(decision: PermissionDecision) { 
    settlePermission?.(decision)
  }

  // 生成一轮回复：
  // 1. 意图识别 + 工具执行（仅用户发言时，由 Agent 完成）；
  // 2. 将工具执行结果附加到人设提示词之后，由 LLM 以角色口吻流式生成最终回复
  async function reply(turn: Turn) {
    // 等会话加载完成，否则找不到当前的会话，会另外新建一个
    await sessionsReady
    const provider = providersStore.getCurrentLLMProvider()
    if (!provider) {
      onErrorHooks.value.forEach(hook => hook(new Error('未配置可用的 LLM Provider')))
      return
    }
    onStartHooks.value.forEach(hook => hook())

    const session = ensureCurrentSession()

    if (turn.type === 'user') {
      const quote = turn.quote?.trim()
      const images = turn.images?.slice(0, MAX_IMAGES)
      session.messages.push({
        role: 'user',
        content: turn.content,
        ...(quote ? { quote: quote.slice(0, MAX_TEXT_LENGTH) } : {}),
        ...(images?.length ? { images } : {}),
      })
      if (session.title === '新对话' && !session.messages.some((m) => m.role === 'assistant')) {
        session.title = (turn.content || (images?.length ? '图片' : '新对话')).slice(0, SESSION_TITLE_LENGTH)
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
    // 交给 Agent 的对话附上之前每轮的工具调用记录，追问时可以直接使用其中的路径等信息
    const agentDialog = toModelMessages(session.messages, { withToolLogs: true })

    // 占位的 assistant 消息，随流式响应实时更新其内容；用户发言时同时记录 Agent 的执行过程
    session.messages.push({ role: 'assistant', content: '', ...(turn.type === 'user' ? { trace: createTrace() } : {}) })
    const assistantIndex = session.messages.length - 1
    // 通过会话取出（响应式的）执行过程再修改，界面才会随之更新
    const trace = () => session.messages[assistantIndex]?.trace

    let fullText = ''
    let isFirstChunk = true
    try {
      const model = resolveLanguageModel(provider)

      // 记忆读取：根据最新的用户消息检索相关的长期记忆，与意图识别并行进行；检索失败不影响对话
      const recallPromise = turn.type === 'user'
        ? memoryStore.recall(dialog).catch((error) => {
            console.warn('[chat] 检索记忆失败：', error)
            return null
          })
        : Promise.resolve(null)

      // 阶段一、二：意图识别与工具执行，不需要技能时返回 null
      let agentResult: AgentResult | null = null
      if (turn.type === 'user') {
        agentResult = await runAgent({
          model,
          messages: agentDialog,
          // 相关记忆也提供给工具执行阶段，便于推断用户没有明说的参数（如所在城市）
          background: recallPromise.then((recalled) => recalled?.facts ?? ''),
          visionModel: agentStore.resolveVisionModel(),
          // 意图识别只区分闲聊与任务，用便宜快速的小模型
          routerModel: agentStore.resolveRouterModel(),
          skills: agentStore.activeSkills,
          directCall: turn.directCall,
          onEvent: (event) => {
            agentStatus.value = describeAgentEvent(event)
            const current = trace()
            if (current) applyAgentEvent(current, event)
          },
          requestPermission,
          setStatus: (status) => { agentStatus.value = status },
          // 工具产生的图片（如截图）附加到这轮的用户消息上，后续追问时图片理解技能可以继续使用
          attachImages: (images) => {
            const userMessage = session.messages[assistantIndex - 1]
            if (userMessage?.role === 'user') userMessage.images = [...(userMessage.images ?? []), ...images]
          },
        })
        if (agentResult) {
          const message = session.messages[assistantIndex]!
          message.skills = agentResult.skills.map((skill) => skill.id)
          if (agentResult.displays.length) message.displays = agentResult.displays
          const toolLog = buildToolLog(agentResult)
          if (toolLog) message.toolLog = toolLog
        }
      }

      const recalled = await recallPromise
      if (recalled) {
        session.messages[assistantIndex]!.memories = recalled.memories.map(({ id, category, content, core }) => ({ id, category, content, core }))
      }

      // 阶段三：以角色口吻润色执行结果（或直接闲聊），系统提示词 = 人设 + 相关记忆 + 技能执行结果
      const system = [systemPrompt, recalled?.prompt, agentResult && buildAgentContextPrompt(agentResult)]
        .filter(Boolean)
        .join('\n\n')
      const currentTrace = trace()
      if (currentTrace) startReply(currentTrace, Date.now(), agentResult?.error)
      const result = streamText({
        model,
        system,
        messages: dialog,
      })

      // 用 fullStream 而不是 textStream：textStream 会丢弃流中的错误（如超出上下文长度、限流），
      // 导致请求失败时只得到一条空回复，界面上也没有任何提示
      for await (const part of result.fullStream) {
        if (part.type === 'error') throw part.error
        if (part.type !== 'text-delta') continue
        const delta = part.text
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
      // 没有出错也没有任何文字（如推理模型把输出额度都用在了思考上）时同样视为失败
      if (!fullText.trim()) throw new Error('模型没有返回任何内容，可能是输出长度不够或被服务商拦截了，可以重试或换一个模型')
      settleTrace(session.messages[assistantIndex])

      onFinishHooks.value.forEach(hook => hook(fullText))

      // 记忆写入：在后台从这一轮对话中提取值得记住的信息，不阻塞下一轮对话。
      // 划词、截图工具栏上的按钮是一次性的操作，不需要整理记忆；
      // 用户在查看或要求忘掉记忆时也不整理，避免刚忘掉的事又被记回去
      const usedMemorySkill = agentResult?.skills.some((skill) => skill.id === MEMORY_SKILL_ID) ?? false
      if (turn.type === 'user' && !turn.directCall && !usedMemorySkill) {
        rememberTurn(session, assistantIndex, model)
      }
    }
    catch (error) {
      const message = session.messages[assistantIndex]
      settleTrace(message, errorMessage(error))
      // 未产生任何内容（文字、结果卡片与执行过程）时移除空的占位回复；
      // 执行过工具时保留，便于查看是哪一步出了问题
      if (!fullText && !message?.displays && !message?.trace) {
        session.messages.splice(assistantIndex, 1)
      }
      onErrorHooks.value.forEach(hook => hook(error))
    }
    finally {
      settlePermission?.('deny')
      agentStatus.value = ''
      isStreaming.value = false
    }
  }

  // 一轮回复结束时结束执行过程；普通闲聊只有意图识别与生成回复，不保留
  function settleTrace(message: ChatMessage | undefined, error?: string) {
    if (!message?.trace) return
    finishTrace(message.trace, Date.now(), error)
    if (!hasExecution(message.trace)) delete message.trace
  }

  // 整理这一轮对话的记忆，完成后在回复下方显示记住了哪些事
  function rememberTurn(session: ChatSession, assistantIndex: number, model: LanguageModel) {
    const assistantMessage = session.messages[assistantIndex]
    const dialog = toMemoryDialog(session.messages.slice(0, assistantIndex + 1))
    const batch = createBatchId('turn')
    memoryStore.memorize(dialog, { model, source: `chat:${session.id}`, batch }).then((updates) => {
      const remembered = updates.flatMap((update): RememberedMemory[] =>
        update.action === 'reinforce'
          ? []
          : [{ action: update.action, category: update.category, content: update.content, ...(update.previous ? { previous: update.previous } : {}) }],
      )
      if (assistantMessage && remembered.length > 0) {
        assistantMessage.remembered = remembered
        assistantMessage.rememberedBatch = batch
      }
    })
  }

  // 撤销某条回复后记住的事情
  async function undoRemembered(message: ChatMessage) {
    if (!message.rememberedBatch) return
    await memoryStore.undo({ batchId: message.rememberedBatch })
    message.remembered = undefined
    message.rememberedBatch = undefined
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
    removeImagesOf(session.messages)
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
    pendingPermission,

    createNewSession,
    switchSession,
    removeSession,
    renameSession,

    sendMessage,
    respondPermission,
    undoRemembered,
    speakProactively,
    onStart,
    onFirstChunkArrived,
    onChunk,
    onFinish,
    onError,
    clearMessages,
  }
})
