<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { SELECTION_SKILL_ID } from '@/agent/skills/selection'
import { useChatStore } from '@/stores/chat'
import { useSceneStore } from '@/stores/scene'
import { useSelectionStore } from '@/stores/selection'

// 无操作多久后自动收起工具栏（毫秒）
const AUTO_HIDE_DELAY = 12000
// 获取失败时提示的展示时长
const MESSAGE_HIDE_DELAY = 3500
// 工具栏与鼠标之间的间距
const OFFSET = 14
const MARGIN = 12

interface SelectionAction {
  id: string
  label: string
  // 作为用户消息展示在对话中的文字
  prompt: string
  toolName: string
  icon: string
}

const ACTIONS: SelectionAction[] = [
  { id: 'translate', label: '翻译', prompt: '帮我翻译一下这段文字', toolName: 'translate_text', icon: 'M4 5h8M8 3v2m2.5 0c-.8 3.5-3 6.5-6.5 8m2.5-4.5c1 2 2.5 3.5 4.5 4.5M13 21l4-10 4 10m-6.5-3.5h5' },
  { id: 'explain', label: '解释', prompt: '这段文字是什么意思？', toolName: 'explain_text', icon: 'M9 9a3 3 0 1 1 4 2.8c-.6.3-1 .9-1 1.6V14m0 3.5v.5M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z' },
  { id: 'summarize', label: '总结', prompt: '帮我总结一下这段文字', toolName: 'summarize_text', icon: 'M8 6h12M8 12h12M8 18h8M4 6h.01M4 12h.01M4 18h.01' },
  { id: 'polish', label: '润色', prompt: '帮我润色一下这段文字', toolName: 'polish_text', icon: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z' },
  { id: 'code', label: '代码', prompt: '帮我分析一下这段代码', toolName: 'analyze_code', icon: 'M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16' },
]

const chatStore = useChatStore()
const sceneStore = useSceneStore()
const selectionStore = useSelectionStore()

const toolbar = computed(() => selectionStore.toolbar)
const toolbarRef = ref<HTMLElement>()
const position = ref({ left: 0, top: 0 })

// 粗略判断选中的内容是否像代码，用于突出「代码」按钮
const looksLikeCode = computed(() => {
  const text = toolbar.value.text
  const signals = [
    /[{};]\s*$/m,
    /=>|::|->|\+\+|===|!=/,
    /^\s*(?:import|export|from|def|class|function|const|let|var|return|public|private|fn|func|package|#include)\b/m,
    /^( {2,}|\t)\S/m,
  ]
  return signals.filter((regex) => regex.test(text)).length >= 2
})

// 根据锚点与工具栏尺寸计算位置，避免超出窗口
async function updatePosition() {
  await nextTick()
  const el = toolbarRef.value
  if (!el) return
  const { width, height } = el.getBoundingClientRect()
  const { x, y } = toolbar.value

  let left = x + OFFSET
  let top = y + OFFSET
  if (left + width > window.innerWidth - MARGIN) left = Math.max(MARGIN, x - OFFSET - width)
  if (top + height > window.innerHeight - MARGIN) top = Math.max(MARGIN, y - OFFSET - height)
  position.value = { left, top }
}

// ===== 自动收起 =====

let hideTimer: ReturnType<typeof setTimeout> | undefined
const hovering = ref(false)

function scheduleHide() {
  clearTimeout(hideTimer)
  if (hovering.value) return
  hideTimer = setTimeout(selectionStore.hideToolbar, toolbar.value.text ? AUTO_HIDE_DELAY : MESSAGE_HIDE_DELAY)
}

function onPointerEnter() {
  hovering.value = true
  clearTimeout(hideTimer)
}

function onPointerLeave() {
  hovering.value = false
  scheduleHide()
}

watch(
  () => [toolbar.value.visible, toolbar.value.x, toolbar.value.y, toolbar.value.text] as const,
  ([visible]) => {
    if (!visible) {
      clearTimeout(hideTimer)
      return
    }
    updatePosition()
    scheduleHide()
  },
)

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && toolbar.value.visible) selectionStore.hideToolbar()
}

// ===== 操作 =====

function openChat() {
  sceneStore.interactiveAreaState.visible = true
}

function runAction(action: SelectionAction) {
  const text = toolbar.value.text
  selectionStore.hideToolbar()
  openChat()
  // 意图已经明确，直接调用对应的工具，结果再由角色润色
  chatStore.sendMessage(action.prompt, {
    quote: text,
    directCall: { skillId: SELECTION_SKILL_ID, toolName: action.toolName, input: { text } },
  })
}

// 提问：把划词内容附加到输入框，由用户自己输入问题
function ask() {
  selectionStore.pendingQuote = toolbar.value.text
  selectionStore.hideToolbar()
  openChat()
}

onMounted(() => {
  selectionStore.init()
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  clearTimeout(hideTimer)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Transition name="toolbar">
    <div
      v-if="toolbar.visible"
      ref="toolbarRef"
      class="selection-toolbar"
      :style="{ left: `${position.left}px`, top: `${position.top}px` }"
      @pointerenter="onPointerEnter"
      @pointerleave="onPointerLeave"
    >
      <template v-if="toolbar.text">
        <div class="preview">
          <p class="preview-text">{{ toolbar.text }}</p>
          <span class="preview-count">{{ toolbar.text.length }} 字</span>
          <button class="close" title="关闭（Esc）" @click="selectionStore.hideToolbar()">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>

        <div class="actions">
          <button
            v-for="action in ACTIONS"
            :key="action.id"
            class="action"
            :class="{ recommended: action.id === 'code' && looksLikeCode }"
            :disabled="chatStore.isStreaming"
            :title="chatStore.isStreaming ? '正在回复中，请稍候' : action.prompt"
            @click="runAction(action)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="action.icon" /></svg>
            {{ action.label }}
          </button>
          <button class="action ask" title="针对这段文字提问" @click="ask">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
            </svg>
            提问
          </button>
        </div>
      </template>

      <p v-else class="message">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5m0 3.5v.5M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z" /></svg>
        {{ toolbar.message }}
      </p>
    </div>
  </Transition>
</template>

<style scoped src="../css/SelectionToolbar.css"></style>
