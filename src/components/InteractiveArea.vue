<script setup lang="ts">
import { useLocalStorage } from '@vueuse/core'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAgentStore } from '@/stores/agent'
import { useChatStore } from '@/stores/chat'
import { usePersonaStore } from '@/stores/persona'
import { useSceneStore } from '@/stores/scene'
import { useSelectionStore } from '@/stores/selection'
import { getInitial, hashHue } from '@/utils/avatar'

// 面板默认尺寸，窗口较小时由 CSS 自动收缩
const PANEL_WIDTH = 600
const PANEL_HEIGHT = 720
// 输入框自动增高的上限
const INPUT_MAX_HEIGHT = 140

const agentStore = useAgentStore()
const chatStore = useChatStore()
const personaStore = usePersonaStore()
const sceneStore = useSceneStore()
const selectionStore = useSelectionStore()

const inputText = ref('')
const errorMessage = ref('')
const messagesContainer = ref<HTMLElement>()
const inputRef = ref<HTMLTextAreaElement>()

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

watch([() => chatStore.visibleMessages.length, lastMessageContent, () => chatStore.agentStatus], () => nextTick(scrollToBottom))
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

// 划词工具栏点击「提问」后，聚焦输入框等待用户输入问题
watch(() => selectionStore.pendingQuote, (quote) => {
  if (quote) nextTick(() => inputRef.value?.focus())
})

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

async function send(content: string) {
  content = content.trim()
  if (!content || chatStore.isStreaming) return

  const quote = selectionStore.pendingQuote
  inputText.value = ''
  errorMessage.value = ''
  selectionStore.pendingQuote = ''
  await chatStore.sendMessage(content, quote ? { quote } : {})
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
    <div v-show="state.visible" class="interactive-area" :style="panelStyle">
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
                <div v-if="message.content || (chatStore.isStreaming && index === chatStore.visibleMessages.length - 1)" class="bubble">
                  <span v-if="message.content">{{ message.content }}</span>
                  <span v-else-if="chatStore.isStreaming && index === chatStore.visibleMessages.length - 1" class="typing">
                    <i></i><i></i><i></i>
                    <span v-if="chatStore.agentStatus" class="agent-status">{{ chatStore.agentStatus }}</span>
                  </span>
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
                <div v-if="message.role === 'assistant' && message.skills?.length" class="skill-tags">
                  <span v-for="id in message.skills" :key="id" class="skill-tag">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
                    </svg>
                    {{ agentStore.getSkillById(id)?.name ?? id }}
                  </span>
                </div>
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
            <div v-if="selectionStore.pendingQuote" class="pending-quote">
              <span class="pending-quote-text">{{ selectionStore.pendingQuote }}</span>
              <button type="button" class="pending-quote-remove" title="移除划词内容" @click="selectionStore.pendingQuote = ''">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
              </button>
            </div>
            <div class="composer">
              <textarea
                ref="inputRef"
                v-model="inputText"
                class="input"
                :placeholder="`和 ${personaName} 说点什么…`"
                rows="1"
                @keydown="handleKeydown"
              />
              <button class="send" type="submit" title="发送" :disabled="!inputText.trim() || chatStore.isStreaming">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            </div>
            <p class="input-hint">Enter 发送 · Shift + Enter 换行</p>
          </form>
        </section>
      </div>
    </div>
  </Transition>
</template>

<style scoped src="../css/InteractiveArea.css"></style>
