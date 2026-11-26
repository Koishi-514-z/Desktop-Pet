<script setup lang="ts">
import { useLocalStorage } from '@vueuse/core'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { MAX_IMAGES } from '@/agent/skills/image'
import { hasExecution } from '@/agent/trace'
import { isTauri } from '@/composables/desktop'
import type { ChatMessage } from '@/stores/chat'
import AgentTrace from '@/components/AgentTrace.vue'
import LinkifiedText from '@/components/LinkifiedText.vue'
import ResizeHandles from '@/components/ResizeHandles.vue'
import { categoryLabel } from '@/memory/types'
import { useAgentStore } from '@/stores/agent'
import { useAudioStore } from '@/stores/audio'
import { useCaptureStore } from '@/stores/capture'
import { useChatStore } from '@/stores/chat'
import { useMicrophoneStore } from '@/stores/microphone'
import { usePersonaStore } from '@/stores/persona'
import { useProvidersStore } from '@/stores/providers'
import { DEFAULT_CHAT_PANEL_SIZE, MIN_CHAT_PANEL_SIZE, useSceneStore } from '@/stores/scene'
import { useTranscriptionStore } from '@/stores/transcription'
import { getInitial, hashHue } from '@/utils/avatar'
import { imageSrc } from '@/utils/images'
import type { PanelRect } from '@/utils/panel-resize'
import { FLOATING_BUTTONS_GAP, fitPanelSize, keepPanelInView, PANEL_MARGIN, viewportSize } from '@/utils/panel-resize'

// 输入框自动增高的上限
const INPUT_MAX_HEIGHT = 140

const agentStore = useAgentStore()
const chatStore = useChatStore()
const personaStore = usePersonaStore()
const sceneStore = useSceneStore()
const captureStore = useCaptureStore()
const microphoneStore = useMicrophoneStore()
const transcriptionStore = useTranscriptionStore()
const providersStore = useProvidersStore()
const audioStore = useAudioStore()

const inputText = ref('')
const errorMessage = ref('')
const messagesContainer = ref<HTMLElement>()
const inputRef = ref<HTMLTextAreaElement>()
const fileInputRef = ref<HTMLInputElement>()

const state = computed(() => sceneStore.interactiveAreaState)

// 会话列表是否收起
const sidebarCollapsed = useLocalStorage('chat/sidebarCollapsed', false)

// ===== 角色信息 =====

const personaName = computed(() => personaStore.currentPersona?.name || '桌宠')

const avatarStyle = computed(() => {
  const hue = hashHue(personaName.value)
  return { background: `linear-gradient(135deg, hsl(${hue} 80% 68%), hsl(${(hue + 35) % 360} 85% 58%))` }
})

const statusText = computed(() => {
  if (chatStore.agentStatus) return chatStore.agentStatus
  if (chatStore.isStreaming) return '正在输入…'
  return '在线'
})

// ===== 拖拽 =====

const dragging = ref(false)
const dragOffset = ref({ x: 0, y: 0 })

// 面板的位置与尺寸（尺寸是用户调整后记住的；窗口较小时 CSS 会再收缩）
const panelStyle = computed(() => ({
  left: `${state.value.position.x}px`,
  top: `${state.value.position.y}px`,
  width: `${sceneStore.chatPanelSize.width}px`,
  height: `${sceneStore.chatPanelSize.height}px`,
}))

function startDrag(event: PointerEvent) {
  // 点击标题栏上的按钮时不触发拖拽
  if ((event.target as HTMLElement).closest('button')) return
  dragging.value = true
  dragOffset.value = {
    x: event.clientX - state.value.position.x,
    y: event.clientY - state.value.position.y,
  }
  window.addEventListener('pointermove', onDrag)
  window.addEventListener('pointerup', stopDrag)
}

function onDrag(event: PointerEvent) {
  if (!dragging.value) return
  state.value.position = {
    x: event.clientX - dragOffset.value.x,
    y: event.clientY - dragOffset.value.y,
  }
}

function stopDrag() {
  dragging.value = false
  window.removeEventListener('pointermove', onDrag)
  window.removeEventListener('pointerup', stopDrag)
}

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onDrag)
  window.removeEventListener('pointerup', stopDrag)
})

// ===== 拖动边、角调整大小（记住调整后的尺寸，见 ResizeHandles）=====

function applyPanelRect(rect: PanelRect) {
  state.value.position = { x: rect.x, y: rect.y }
  sceneStore.chatPanelSize = { width: rect.width, height: rect.height }
}

// 双击边、角恢复默认尺寸（左上角不动；放不下时往回挪，不挡住右下角的悬浮按钮）
function resetPanelSize() {
  const size = fitPanelSize(DEFAULT_CHAT_PANEL_SIZE, { min: MIN_CHAT_PANEL_SIZE, bounds: viewportSize(), margin: PANEL_MARGIN })
  sceneStore.chatPanelSize = size
  state.value.position = keepPanelInView(state.value.position, size, viewportSize(), FLOATING_BUTTONS_GAP)
}

// ===== 消息列表 =====

// 当前会话的最后一条消息内容，流式响应时会持续变化，用于触发自动滚动
const lastMessageContent = computed(() => chatStore.visibleMessages.at(-1)?.content)
// 执行过程新增步骤或工具调用时也滚动到底部
const lastTraceSize = computed(() => {
  const nodes = chatStore.visibleMessages.at(-1)?.trace?.nodes ?? []
  return nodes.reduce((size, node) => size + 1 + (node.kind === 'step' ? node.tools.length : 0), 0)
})

function scrollToBottom() {
  const el = messagesContainer.value
  if (!el) return
  el.scrollTop = el.scrollHeight
}

watch(
  [() => chatStore.visibleMessages.length, lastMessageContent, lastTraceSize, () => chatStore.agentStatus, () => chatStore.pendingPermission, () => chatStore.pendingQuestion],
  () => nextTick(scrollToBottom),
)
watch(() => chatStore.currentSessionId, () => nextTick(scrollToBottom))
watch(() => state.value.visible, (visible) => visible && nextTick(scrollToBottom))

// 会话列表中的相对时间
function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  const date = new Date(timestamp)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

// ===== 划词引用与结果卡片 =====

// 已展开全文的划词引用
const expandedQuotes = ref(new Set<string>())

function toggleQuote(key: string) {
  const set = new Set(expandedQuotes.value)
  if (set.has(key)) set.delete(key)
  else set.add(key)
  expandedQuotes.value = set
}

// 撤销某条回复后记住的事情
async function handleUndoRemembered(message: ChatMessage) {
  try {
    await chatStore.undoRemembered(message)
  }
  catch (error) {
    errorMessage.value = `撤销失败：${error instanceof Error ? error.message : String(error)}`
  }
}

// 刚复制过的结果卡片，用于短暂显示「已复制」
const copiedKey = ref('')
let copiedTimer: ReturnType<typeof setTimeout> | undefined

async function copyText(key: string, text: string) {
  try {
    await navigator.clipboard.writeText(text)
    copiedKey.value = key
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copiedKey.value = ''), 1500)
  }
  catch (error) {
    errorMessage.value = `复制失败：${error instanceof Error ? error.message : String(error)}`
  }
}

onBeforeUnmount(() => clearTimeout(copiedTimer))

// 划词 / 截图工具栏点击「提问」后，聚焦输入框等待用户输入问题
watch(
  () => [captureStore.pendingQuote, captureStore.pendingImages.length] as const,
  ([quote, imageCount]) => {
    if (quote || imageCount) nextTick(() => inputRef.value?.focus())
  },
)

// 正在查看大图的图片 id，按 Esc 关闭
const previewImageId = ref('')

function closePreviewOnEscape(event: KeyboardEvent) {
  if (event.key === 'Escape') previewImageId.value = ''
}

onMounted(() => window.addEventListener('keydown', closePreviewOnEscape))
onBeforeUnmount(() => window.removeEventListener('keydown', closePreviewOnEscape))

// ===== 添加图片：粘贴、拖入、选择文件、截图 =====

const addingImage = ref(false)
const fileDragging = ref(false)
const canAddImage = computed(() => captureStore.pendingImages.length < MAX_IMAGES && !addingImage.value)

async function addImages(sources: (Blob | string)[]) {
  if (sources.length === 0) return
  errorMessage.value = ''
  addingImage.value = true
  try {
    for (const source of sources) {
      if (captureStore.pendingImages.length >= MAX_IMAGES) {
        errorMessage.value = `一次最多发送 ${MAX_IMAGES} 张图片`
        break
      }
      await captureStore.addPendingImage(source)
    }
  }
  catch (error) {
    errorMessage.value = `添加图片失败：${error instanceof Error ? error.message : String(error)}`
  }
  finally {
    addingImage.value = false
  }
}

function imageFilesOf(items: Iterable<File> | null | undefined): File[] {
  return [...(items ?? [])].filter((file) => file.type.startsWith('image/'))
}

// 粘贴图片（如 Win + Shift + S 截图后直接粘贴）；只有文字时交给输入框默认处理
function handlePaste(event: ClipboardEvent) {
  const files = imageFilesOf(event.clipboardData?.files)
  if (files.length === 0) return
  event.preventDefault()
  addImages(files)
}

function handleDragOver(event: DragEvent) {
  if (![...(event.dataTransfer?.types ?? [])].includes('Files')) return
  event.preventDefault()
  fileDragging.value = true
}

function handleDragLeave(event: DragEvent) {
  // 移动到子元素上时也会触发 dragleave，只在真正离开面板时取消高亮
  if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) fileDragging.value = false
}

function handleDrop(event: DragEvent) {
  fileDragging.value = false
  const files = imageFilesOf(event.dataTransfer?.files)
  if (files.length === 0) return
  event.preventDefault()
  addImages(files)
}

function handleFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  addImages(imageFilesOf(input.files))
  input.value = ''
}

// 截图时先收起面板，避免挡住要截取的内容
async function handleScreenshot() {
  errorMessage.value = ''
  state.value.visible = false
  try {
    const image = await captureStore.takeScreenshot()
    if (image) await addImages([image])
  }
  catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  }
  finally {
    state.value.visible = true
  }
}

// ===== 清空会话（需要二次确认） =====

const confirmingClear = ref(false)
let confirmTimer: ReturnType<typeof setTimeout> | undefined

function handleClear() {
  if (!confirmingClear.value) {
    confirmingClear.value = true
    clearTimeout(confirmTimer)
    confirmTimer = setTimeout(() => (confirmingClear.value = false), 3000)
    return
  }
  clearTimeout(confirmTimer)
  confirmingClear.value = false
  chatStore.clearMessages()
}

onBeforeUnmount(() => clearTimeout(confirmTimer))

// ===== 输入 =====

// 输入框随内容自动增高
function resizeInput() {
  const el = inputRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, INPUT_MAX_HEIGHT)}px`
}

watch(inputText, () => nextTick(resizeInput))

// 桌宠在执行中途提问时，输入框中的内容作为回答发送（只能回答文字；只能从选项中选择时不能输入）
const canSend = computed(() => {
  const question = chatStore.pendingQuestion?.question
  if (question) return (!question.options?.length || question.allowCustom !== false) && !!inputText.value.trim()
  return (!!inputText.value.trim() || captureStore.pendingImages.length > 0) && !chatStore.isStreaming && !addingImage.value
})

// 桌宠正在回复：正在生成回复，或者语音还没播完
const petBusy = computed(() => chatStore.isStreaming || audioStore.isPlaying || audioStore.speechPending)
// 桌宠正在回复、又没有可以发送的内容时，发送按钮变成打断按钮
const showInterrupt = computed(() => petBusy.value && !canSend.value)

// 在面板中按 Esc 打断。正在查看大图时 Esc 只关闭大图（由窗口上的监听处理）；
// 不监听整个窗口，免得和划词工具栏等其他用 Esc 关闭的界面冲突
function handlePanelEscape(event: KeyboardEvent) {
  if (event.isComposing || previewImageId.value || !petBusy.value) return
  chatStore.interrupt()
}

async function send(content: string) {
  content = content.trim()
  if (!canSend.value) return

  if (chatStore.pendingQuestion) {
    inputText.value = ''
    chatStore.answerQuestion(content)
    return
  }

  const { quote, images } = captureStore.takePending()
  inputText.value = ''
  errorMessage.value = ''
  await chatStore.sendMessage(content, { ...(quote ? { quote } : {}), ...(images.length ? { images } : {}) })
}

// 发送当前输入框中的内容
function handleSend() {
  send(inputText.value)
}

// Enter 发送，Shift+Enter 换行；输入法组字期间的 Enter 不发送
function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    handleSend()
  }
}

// 卸载时注销：chatStore 是单例，组件重新挂载后旧钩子仍会被调用
const disposeErrorHook = chatStore.onError(async (error) => {
  errorMessage.value = error instanceof Error ? error.message : String(error)
})
onBeforeUnmount(disposeErrorHook)

// ===== 语音输入 =====
// 打开后一直在听：说完一句话会自动识别并发送（见 Stage 中的语音输入管线），面板关闭后也会继续听

function toggleMicrophone() {
  if (!microphoneStore.isListening && !providersStore.getCurrentASRProvider()) {
    errorMessage.value = '还没有设置语音识别：请在「设置 → 服务商 → 语音识别 (ASR)」中填写并选用一个'
    return
  }
  microphoneStore.toggle()
}

watch(() => microphoneStore.error, (error) => {
  if (error) errorMessage.value = error
})

watch(() => transcriptionStore.error, (error) => {
  if (error) errorMessage.value = `语音识别失败：${error}`
})

const microphoneTitle = computed(() => {
  if (microphoneStore.isStarting) return '正在打开麦克风…'
  return microphoneStore.isListening ? '关闭语音输入' : '语音输入：开启后说完话会自动发送'
})

// 输入框下方的提示：语音输入打开时显示正在做什么
const inputHint = computed(() => {
  if (!microphoneStore.isListening) return petBusy.value ? '按 Esc 可以打断' : 'Enter 发送 · Shift + Enter 换行 · 可以粘贴或拖入图片'
  if (microphoneStore.userSpeaking) return '正在听你说…'
  if (transcriptionStore.isTranscribing) return '正在识别…'
  if (audioStore.isPlaying || audioStore.speechPending) return `等 ${personaName.value} 说完再听，按 Esc 可以打断`
  return '正在聆听，说完后会自动发送'
})

// ===== 执行中途的提问 =====

// 提问卡片中输入的回答
const questionAnswer = ref('')
const questionInputRef = ref<HTMLInputElement[]>([])

// 是否显示输入框：没有选项，或者有选项但也允许自己输入
const questionHasInput = computed(() => {
  const question = chatStore.pendingQuestion?.question
  return !!question && (!question.options?.length || question.allowCustom !== false)
})

// 出现新的问题时清空上次的回答；只有输入框时聚焦，直接输入就能回答
watch(() => chatStore.pendingQuestion?.id, (id) => {
  questionAnswer.value = ''
  if (id && !chatStore.pendingQuestion?.question.options?.length) nextTick(() => questionInputRef.value[0]?.focus())
})

function submitQuestionAnswer() {
  if (!questionAnswer.value.trim()) return
  chatStore.answerQuestion(questionAnswer.value)
}

onMounted(() => {
  // 默认放在右下角悬浮按钮的左侧。按记住的尺寸算位置；窗口放不下时按收缩后的大小算
  // （只是显示时由 CSS 收缩，记住的尺寸不变，回到大屏幕时还是原来的大小）
  const size = fitPanelSize(sceneStore.chatPanelSize, { min: MIN_CHAT_PANEL_SIZE, bounds: viewportSize(), margin: PANEL_MARGIN })
  state.value.position = keepPanelInView({ x: Infinity, y: Infinity }, size, viewportSize(), FLOATING_BUTTONS_GAP)
})
</script>

<template>
  <button class="toggle-button" :title="state.visible ? '收起对话' : '打开对话'" @click="state.visible = !state.visible">
    {{ state.visible ? '×' : '💬' }}
  </button>

  <Transition name="panel">
    <!-- 外框负责位置、尺寸与显示：调整大小的手柄跨在面板边缘（面板本身裁掉了溢出的内容，手柄放不进去） -->
    <div v-show="state.visible" class="panel-frame" :style="panelStyle">
      <div
        class="interactive-area"
        :class="{ 'file-dragging': fileDragging }"
        @keydown.esc="handlePanelEscape"
        @dragover="handleDragOver"
        @dragleave="handleDragLeave"
        @drop="handleDrop"
      >
        <header class="panel-header" @pointerdown="startDrag">
          <button
            class="icon-button"
            :class="{ active: !sidebarCollapsed }"
            :title="sidebarCollapsed ? '展开会话列表' : '收起会话列表'"
            @click="sidebarCollapsed = !sidebarCollapsed"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="3" />
              <path d="M9 4v16" />
            </svg>
          </button>

          <div class="persona">
            <span class="avatar" :style="avatarStyle">
              {{ getInitial(personaName) }}
              <i class="presence" :class="{ busy: chatStore.isStreaming }" />
            </span>
            <span class="persona-text">
              <span class="persona-name">{{ personaName }}</span>
              <span class="persona-status" :class="{ busy: chatStore.isStreaming }">{{ statusText }}</span>
            </span>
          </div>

          <div class="header-actions">
            <button
              class="icon-button"
              :class="{ danger: confirmingClear }"
              :title="confirmingClear ? '再次点击确认清空' : '清空当前会话'"
              :disabled="chatStore.isStreaming || chatStore.visibleMessages.length === 0"
              @click="handleClear"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
              </svg>
              <span v-if="confirmingClear" class="confirm-text">确认清空？</span>
            </button>
            <button class="icon-button" title="关闭" @click="state.visible = false">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
        </header>

        <div class="panel-body">
          <aside class="session-list" :class="{ collapsed: sidebarCollapsed }">
            <button class="new-session" @click="chatStore.createNewSession()">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              新对话
            </button>

            <ul>
              <li
                v-for="session in chatStore.sessions"
                :key="session.id"
                class="session-item"
                :class="{ active: session.id === chatStore.currentSessionId }"
                @click="chatStore.switchSession(session.id)"
              >
                <span class="session-text">
                  <span class="title">{{ session.title }}</span>
                  <span class="time">{{ formatRelativeTime(session.updatedAt) }}</span>
                </span>
                <button class="remove" title="删除会话" @click.stop="chatStore.removeSession(session.id)">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M6 6l12 12M18 6 6 18" />
                  </svg>
                </button>
              </li>
            </ul>
          </aside>

          <section class="chat-panel">
            <div ref="messagesContainer" class="messages">
              <div
                v-for="(message, index) in chatStore.visibleMessages"
                :key="`${chatStore.currentSessionId}-${index}`"
                class="message"
                :class="message.role"
              >
                <span v-if="message.role === 'assistant'" class="avatar small" :style="avatarStyle">
                  {{ getInitial(personaName) }}
                </span>
                <div class="message-body">
                  <button
                    v-if="message.quote"
                    class="quote"
                    :class="{ expanded: expandedQuotes.has(`${chatStore.currentSessionId}-${index}`) }"
                    :title="expandedQuotes.has(`${chatStore.currentSessionId}-${index}`) ? '收起' : '展开全文'"
                    @click="toggleQuote(`${chatStore.currentSessionId}-${index}`)"
                  >
                    {{ message.quote }}
                  </button>
                  <div v-if="message.images?.length" class="message-images">
                    <button
                      v-for="image in message.images"
                      :key="image.id"
                      class="message-image"
                      title="查看大图"
                      :style="{ aspectRatio: `${image.width} / ${image.height}` }"
                      @click="previewImageId = image.id"
                    >
                      <img v-if="imageSrc(image.id)" :src="imageSrc(image.id)" alt="图片" />
                    </button>
                  </div>
                  <AgentTrace
                    v-if="message.trace && hasExecution(message.trace)"
                    :trace="message.trace"
                    :live="chatStore.isStreaming && index === chatStore.visibleMessages.length - 1"
                  />
                  <div v-if="message.content || (chatStore.isStreaming && index === chatStore.visibleMessages.length - 1)" class="bubble">
                    <span v-if="message.content">{{ message.content }}</span>
                    <span v-else-if="chatStore.isStreaming && index === chatStore.visibleMessages.length - 1" class="typing">
                      <i></i><i></i><i></i>
                      <span v-if="chatStore.agentStatus" class="agent-status">{{ chatStore.agentStatus }}</span>
                    </span>
                  </div>
                  <div
                    v-if="chatStore.pendingPermission && index === chatStore.visibleMessages.length - 1"
                    :key="chatStore.pendingPermission.id"
                    class="permission-card"
                  >
                    <div class="permission-head">
                      <span class="permission-icon">
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <rect x="2" y="3" width="20" height="14" rx="2" />
                          <path d="M8 21h8M12 17v4" />
                        </svg>
                      </span>
                      <div class="permission-text">
                        <p class="permission-title">{{ personaName }} 想{{ chatStore.pendingPermission.request.title }}</p>
                        <p class="permission-reason">{{ chatStore.pendingPermission.request.reason }}</p>
                      </div>
                    </div>
                    <p
                      v-if="chatStore.pendingPermission.request.target"
                      class="permission-target"
                      :class="{ code: chatStore.pendingPermission.request.targetFormat === 'code' }"
                    >
                      <span>{{ chatStore.pendingPermission.request.targetLabel ?? '对象' }}</span>{{ chatStore.pendingPermission.request.target }}
                    </p>
                    <p v-if="chatStore.pendingPermission.request.notice" class="permission-notice">
                      {{ chatStore.pendingPermission.request.notice }}
                    </p>
                    <div class="permission-actions">
                      <button class="permission-button" @click="chatStore.respondPermission('deny')">拒绝</button>
                      <button
                        v-if="chatStore.pendingPermission.request.allowAlways !== false"
                        class="permission-button"
                        @click="chatStore.respondPermission('always')"
                      >
                        始终允许
                      </button>
                      <button class="permission-button primary" @click="chatStore.respondPermission('once')">允许这一次</button>
                    </div>
                  </div>
                  <div
                    v-if="chatStore.pendingQuestion && index === chatStore.visibleMessages.length - 1"
                    :key="chatStore.pendingQuestion.id"
                    class="permission-card question-card"
                  >
                    <div class="permission-head">
                      <span class="permission-icon">
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <circle cx="12" cy="12" r="9" />
                          <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01" />
                        </svg>
                      </span>
                      <div class="permission-text">
                        <p class="permission-title">{{ personaName }} 想问你</p>
                        <p class="permission-reason">{{ chatStore.pendingQuestion.question.question }}</p>
                      </div>
                    </div>
                    <div v-if="chatStore.pendingQuestion.question.options?.length" class="question-options">
                      <button
                        v-for="option in chatStore.pendingQuestion.question.options"
                        :key="option"
                        class="permission-button question-option"
                        type="button"
                        @click="chatStore.answerQuestion(option)"
                      >
                        {{ option }}
                      </button>
                    </div>
                    <form v-if="questionHasInput" class="question-input" @submit.prevent="submitQuestionAnswer">
                      <input
                        ref="questionInputRef"
                        v-model="questionAnswer"
                        class="question-field"
                        :placeholder="chatStore.pendingQuestion.question.placeholder
                          || (chatStore.pendingQuestion.question.options?.length ? '或者输入其他回答' : '输入你的回答')"
                      />
                      <button class="permission-button primary" type="submit" :disabled="!questionAnswer.trim()">回答</button>
                    </form>
                    <div class="permission-actions">
                      <span v-if="questionHasInput" class="question-hint">也可以直接在下方的输入框中回答</span>
                      <button class="permission-button" type="button" @click="chatStore.answerQuestion(null)">跳过</button>
                    </div>
                  </div>
                  <div
                    v-for="(display, displayIndex) in message.displays ?? []"
                    :key="displayIndex"
                    class="result-card"
                  >
                    <header class="result-head">
                      <span class="result-title">{{ display.title }}</span>
                      <button
                        class="result-copy"
                        :class="{ copied: copiedKey === `${chatStore.currentSessionId}-${index}-${displayIndex}` }"
                        @click="copyText(`${chatStore.currentSessionId}-${index}-${displayIndex}`, display.content)"
                      >
                        <svg v-if="copiedKey === `${chatStore.currentSessionId}-${index}-${displayIndex}`" viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M5 12l5 5L20 7" />
                        </svg>
                        <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                          <rect x="9" y="9" width="11" height="11" rx="2" />
                          <path d="M5 15V6a2 2 0 0 1 2-2h9" />
                        </svg>
                        {{ copiedKey === `${chatStore.currentSessionId}-${index}-${displayIndex}` ? '已复制' : '复制' }}
                      </button>
                    </header>
                    <div class="result-content" :class="display.format"><LinkifiedText :text="display.content" /></div>
                  </div>
                  <div v-if="message.role === 'assistant' && (message.skills?.length || message.memories?.length || message.remembered?.length || message.proactive || message.interrupted)" class="skill-tags">
                    <span v-if="message.interrupted" class="skill-tag interrupted-tag" title="这条回复被打断了，没有说完">
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="6" y="6" width="12" height="12" rx="2" />
                      </svg>
                      已打断
                    </span>
                    <span v-if="message.proactive" class="skill-tag proactive-tag" title="桌宠主动说的话">
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
                      </svg>
                      主动 · {{ message.proactive.trigger }}
                    </span>
                    <button
                      v-if="message.memories?.length"
                      class="skill-tag memory-tag"
                      :class="{ active: expandedQuotes.has(`memory-${chatStore.currentSessionId}-${index}`) }"
                      title="这次回复时想起的事情"
                      @click="toggleQuote(`memory-${chatStore.currentSessionId}-${index}`)"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 3a6 6 0 0 0-6 6c0 2.2 1.2 3.6 2.2 4.6.6.6.8 1.2.8 2V17h6v-1.4c0-.8.2-1.4.8-2 1-1 2.2-2.4 2.2-4.6a6 6 0 0 0-6-6zM10 21h4" />
                      </svg>
                      想起了 {{ message.memories.length }} 件事
                    </button>
                    <button
                      v-if="message.remembered?.length"
                      class="skill-tag memory-tag remembered"
                      :class="{ active: expandedQuotes.has(`remembered-${chatStore.currentSessionId}-${index}`) }"
                      title="这一轮对话后记住的事情"
                      @click="toggleQuote(`remembered-${chatStore.currentSessionId}-${index}`)"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 3a6 6 0 0 0-6 6c0 2.2 1.2 3.6 2.2 4.6.6.6.8 1.2.8 2V17h6v-1.4c0-.8.2-1.4.8-2 1-1 2.2-2.4 2.2-4.6a6 6 0 0 0-6-6zM10 21h4M12 7v4M10 9h4" />
                      </svg>
                      记住了 {{ message.remembered.length }} 件事
                    </button>
                    <span v-for="id in message.skills ?? []" :key="id" class="skill-tag">
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
                      </svg>
                      {{ agentStore.getSkillById(id)?.name ?? id }}
                    </span>
                  </div>
                  <ul v-if="message.memories?.length && expandedQuotes.has(`memory-${chatStore.currentSessionId}-${index}`)" class="memory-list">
                    <li v-for="memory in message.memories" :key="memory.id">
                      <span class="memory-category">{{ categoryLabel(memory.category) }}</span>
                      <span>{{ memory.content }}</span>
                    </li>
                  </ul>
                  <ul v-if="message.remembered?.length && expandedQuotes.has(`remembered-${chatStore.currentSessionId}-${index}`)" class="memory-list remembered">
                    <li v-for="(memory, memoryIndex) in message.remembered" :key="memoryIndex">
                      <span class="memory-category">{{ memory.action === 'add' ? '新增' : '更新' }} · {{ categoryLabel(memory.category) }}</span>
                      <span class="memory-change">
                        <span>{{ memory.content }}</span>
                        <s v-if="memory.previous" class="memory-previous">{{ memory.previous }}</s>
                      </span>
                    </li>
                    <li v-if="message.rememberedBatch" class="memory-actions">
                      <button class="memory-undo" type="button" title="撤销这一轮记忆的变动" @click="handleUndoRemembered(message)">
                        撤销
                      </button>
                    </li>
                  </ul>
                </div>
              </div>
            </div>

            <Transition name="fade">
              <p v-if="errorMessage" class="error">
                <span>{{ errorMessage }}</span>
                <button class="error-close" title="关闭" @click="errorMessage = ''">×</button>
              </p>
            </Transition>

            <form class="input-area" @submit.prevent="handleSend">
              <div v-if="captureStore.pendingQuote" class="pending-quote">
                <span class="pending-quote-text">{{ captureStore.pendingQuote }}</span>
                <button type="button" class="pending-quote-remove" title="移除划词内容" @click="captureStore.pendingQuote = ''">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
                </button>
              </div>
              <div v-if="captureStore.pendingImages.length || addingImage" class="pending-images">
                <div v-for="image in captureStore.pendingImages" :key="image.id" class="pending-image">
                  <img v-if="imageSrc(image.id)" :src="imageSrc(image.id)" alt="待发送的图片" @click="previewImageId = image.id" />
                  <button type="button" class="pending-image-remove" title="移除图片" @click="captureStore.removePendingImage(image.id)">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
                  </button>
                </div>
                <div v-if="addingImage" class="pending-image loading" />
              </div>
              <div class="composer">
                <div class="composer-tools">
                  <button
                    type="button"
                    class="tool-button"
                    :title="canAddImage ? '添加图片（也可以直接粘贴或拖入）' : `一次最多发送 ${MAX_IMAGES} 张图片`"
                    :disabled="!canAddImage"
                    @click="fileInputRef?.click()"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <rect x="3" y="4" width="18" height="16" rx="3" />
                      <circle cx="9" cy="10" r="2" />
                      <path d="m21 16-5-5-9 9" />
                    </svg>
                  </button>
                  <button
                    v-if="isTauri"
                    type="button"
                    class="tool-button"
                    title="截图"
                    :disabled="!canAddImage"
                    @click="handleScreenshot"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    class="tool-button mic-button"
                    :class="{ active: microphoneStore.isListening, hearing: microphoneStore.userSpeaking }"
                    :style="{ '--level': microphoneStore.level }"
                    :title="microphoneTitle"
                    :aria-pressed="microphoneStore.isListening"
                    :disabled="microphoneStore.isStarting"
                    @click="toggleMicrophone"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <rect x="9" y="3" width="6" height="11" rx="3" />
                      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
                    </svg>
                  </button>
                  <input ref="fileInputRef" type="file" accept="image/*" multiple hidden @change="handleFileChange" />
                </div>
                <textarea
                  ref="inputRef"
                  v-model="inputText"
                  class="input"
                  :placeholder="!chatStore.pendingQuestion ? `和 ${personaName} 说点什么…` : questionHasInput ? `回答 ${personaName} 的问题…` : '请在上方选择一个回答'"
                  rows="1"
                  @keydown="handleKeydown"
                  @paste="handlePaste"
                />
                <button v-if="showInterrupt" class="send interrupt" type="button" title="打断（Esc）" @click="chatStore.interrupt()">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="7" y="7" width="10" height="10" rx="2" />
                  </svg>
                </button>
                <button v-else class="send" type="submit" title="发送" :disabled="!canSend">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </button>
              </div>
              <p class="input-hint" :class="{ listening: microphoneStore.isListening }">{{ inputHint }}</p>
            </form>
          </section>
        </div>

        <div v-if="fileDragging" class="drop-overlay">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="3" />
            <circle cx="9" cy="10" r="2" />
            <path d="m21 16-5-5-9 9" />
          </svg>
          松开以添加图片
        </div>

        <Transition name="fade">
          <div v-if="previewImageId" class="image-preview" title="点击关闭" @click="previewImageId = ''">
            <img :src="imageSrc(previewImageId)" alt="图片预览" />
          </div>
        </Transition>
      </div>

      <!-- 拖动边、角调整大小，双击恢复默认尺寸 -->
      <ResizeHandles :min="MIN_CHAT_PANEL_SIZE" @resize="applyPanelRect" @reset="resetPanelSize" />
    </div>
  </Transition>
</template>

<style scoped src="../css/InteractiveArea.css"></style>
