<script setup lang="ts">
import { useLocalStorage } from '@vueuse/core'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { MAX_IMAGES } from '@/agent/skills/image'
import { isTauri } from '@/composables/desktop'
import type { ChatMessage } from '@/stores/chat'
import { categoryLabel } from '@/memory/types'
import { useAgentStore } from '@/stores/agent'
import { useCaptureStore } from '@/stores/capture'
import { useChatStore } from '@/stores/chat'
import { usePersonaStore } from '@/stores/persona'
import { useSceneStore } from '@/stores/scene'
import { getInitial, hashHue } from '@/utils/avatar'
import { imageSrc } from '@/utils/images'

// 面板默认尺寸，窗口较小时由 CSS 自动收缩
const PANEL_WIDTH = 600
const PANEL_HEIGHT = 720
// 输入框自动增高的上限
const INPUT_MAX_HEIGHT = 140

const agentStore = useAgentStore()
const chatStore = useChatStore()
const personaStore = usePersonaStore()
const sceneStore = useSceneStore()
const captureStore = useCaptureStore()

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

const panelStyle = computed(() => ({
  left: `${state.value.position.x}px`,
  top: `${state.value.position.y}px`,
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

// ===== 消息列表 =====

// 当前会话的最后一条消息内容，流式响应时会持续变化，用于触发自动滚动
const lastMessageContent = computed(() => chatStore.visibleMessages.at(-1)?.content)

function scrollToBottom() {
  const el = messagesContainer.value
  if (!el) return
  el.scrollTop = el.scrollHeight
}

watch(
  [() => chatStore.visibleMessages.length, lastMessageContent, () => chatStore.agentStatus, () => chatStore.pendingPermission],
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

const canSend = computed(() =>
  (!!inputText.value.trim() || captureStore.pendingImages.length > 0) && !chatStore.isStreaming && !addingImage.value,
)

async function send(content: string) {
  content = content.trim()
  if (!canSend.value) return

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

chatStore.onError(async (error) => {
  errorMessage.value = error instanceof Error ? error.message : String(error)
})

onMounted(() => {
  // 默认放在右下角悬浮按钮的左侧
  state.value.position = {
    x: Math.max(16, window.innerWidth - PANEL_WIDTH - 88),
    y: Math.max(16, window.innerHeight - PANEL_HEIGHT - 24),
  }
})
</script>

<template>
  <button class="toggle-button" :title="state.visible ? '收起对话' : '打开对话'" @click="state.visible = !state.visible">
    {{ state.visible ? '×' : '💬' }}
  </button>

  <Transition name="panel">
    <div
      v-show="state.visible"
      class="interactive-area"
      :class="{ 'file-dragging': fileDragging }"
      :style="panelStyle"
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
                  <p v-if="chatStore.pendingPermission.request.target" class="permission-target">
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
                  <div class="result-content" :class="display.format">{{ display.content }}</div>
                </div>
                <div v-if="message.role === 'assistant' && (message.skills?.length || message.memories?.length || message.remembered?.length)" class="skill-tags">
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
                <input ref="fileInputRef" type="file" accept="image/*" multiple hidden @change="handleFileChange" />
              </div>
              <textarea
                ref="inputRef"
                v-model="inputText"
                class="input"
                :placeholder="`和 ${personaName} 说点什么…`"
                rows="1"
                @keydown="handleKeydown"
                @paste="handlePaste"
              />
              <button class="send" type="submit" title="发送" :disabled="!canSend">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            </div>
            <p class="input-hint">Enter 发送 · Shift + Enter 换行 · 可以粘贴或拖入图片</p>
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
  </Transition>
</template>

<style scoped src="../css/InteractiveArea.css"></style>
