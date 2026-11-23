<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { IMAGE_SKILL_ID } from '@/agent/skills/image'
import { SELECTION_SKILL_ID } from '@/agent/skills/selection'
import { useCaptureStore } from '@/stores/capture'
import { useChatStore } from '@/stores/chat'
import { useSceneStore } from '@/stores/scene'
import { addImage } from '@/utils/images'

// 无操作多久后自动收起工具栏（毫秒）
const AUTO_HIDE_DELAY = 12000
// 获取失败时提示的展示时长
const MESSAGE_HIDE_DELAY = 3500
// 工具栏与鼠标之间的间距
const OFFSET = 14
const MARGIN = 12

interface CaptureAction {
  id: string
  label: string
  // 作为用户消息展示在对话中的文字
  prompt: string
  toolName: string
  icon: string
}

const ICONS = {
  translate: 'M4 5h8M8 3v2m2.5 0c-.8 3.5-3 6.5-6.5 8m2.5-4.5c1 2 2.5 3.5 4.5 4.5M13 21l4-10 4 10m-6.5-3.5h5',
  explain: 'M9 9a3 3 0 1 1 4 2.8c-.6.3-1 .9-1 1.6V14m0 3.5v.5M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
  summarize: 'M8 6h12M8 12h12M8 18h8M4 6h.01M4 12h.01M4 18h.01',
  polish: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16',
  describe: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  extract: 'M4 7V4h3M17 4h3v3M20 17v3h-3M7 20H4v-3M8 9h8M8 12h8M8 15h5',
  error: 'M12 9v4m0 3.5v.5M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
}

const TEXT_ACTIONS: CaptureAction[] = [
  { id: 'translate', label: '翻译', prompt: '帮我翻译一下这段文字', toolName: 'translate_text', icon: ICONS.translate },
  { id: 'explain', label: '解释', prompt: '这段文字是什么意思？', toolName: 'explain_text', icon: ICONS.explain },
  { id: 'summarize', label: '总结', prompt: '帮我总结一下这段文字', toolName: 'summarize_text', icon: ICONS.summarize },
  { id: 'polish', label: '润色', prompt: '帮我润色一下这段文字', toolName: 'polish_text', icon: ICONS.polish },
  { id: 'code', label: '代码', prompt: '帮我分析一下这段代码', toolName: 'analyze_code', icon: ICONS.code },
]

const IMAGE_ACTIONS: CaptureAction[] = [
  { id: 'describe', label: '解释', prompt: '这张图里是什么？', toolName: 'describe_image', icon: ICONS.describe },
  { id: 'extract', label: '文字', prompt: '帮我提取图片中的文字', toolName: 'extract_image_text', icon: ICONS.extract },
  { id: 'translate', label: '翻译', prompt: '帮我翻译一下图片中的文字', toolName: 'translate_image', icon: ICONS.translate },
  { id: 'error', label: '报错', prompt: '帮我看看这个报错', toolName: 'analyze_error', icon: ICONS.error },
]

const captureStore = useCaptureStore()
const chatStore = useChatStore()
const sceneStore = useSceneStore()

const toolbar = computed(() => captureStore.toolbar)
const toolbarRef = ref<HTMLElement>()
const position = ref({ left: 0, top: 0 })
const busy = ref(false)
const actionError = ref('')

const isImage = computed(() => !!toolbar.value.image)
const actions = computed(() => (isImage.value ? IMAGE_ACTIONS : TEXT_ACTIONS))
const hasContent = computed(() => !!toolbar.value.text || isImage.value)

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
  if (hovering.value || busy.value) return
  hideTimer = setTimeout(captureStore.hideToolbar, hasContent.value ? AUTO_HIDE_DELAY : MESSAGE_HIDE_DELAY)
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
  () => [toolbar.value.visible, toolbar.value.x, toolbar.value.y, toolbar.value.text, toolbar.value.image] as const,
  ([visible]) => {
    actionError.value = ''
    if (!visible) {
      clearTimeout(hideTimer)
      return
    }
    updatePosition()
    scheduleHide()
  },
)

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && toolbar.value.visible) captureStore.hideToolbar()
}

// ===== 操作 =====

function openChat() {
  sceneStore.interactiveAreaState.visible = true
}

async function runAction(action: CaptureAction) {
  const { text, image } = toolbar.value

  // 意图已经明确，直接调用对应的工具，结果再由角色润色
  if (image) {
    busy.value = true
    try {
      const imageRef = await addImage(image)
      captureStore.hideToolbar()
      openChat()
      chatStore.sendMessage(action.prompt, {
        images: [imageRef],
        directCall: { skillId: IMAGE_SKILL_ID, toolName: action.toolName, input: { imageIds: [imageRef.id] } },
      })
    }
    catch (error) {
      actionError.value = error instanceof Error ? error.message : String(error)
    }
    finally {
      busy.value = false
    }
    return
  }

  captureStore.hideToolbar()
  openChat()
  chatStore.sendMessage(action.prompt, {
    quote: text,
    directCall: { skillId: SELECTION_SKILL_ID, toolName: action.toolName, input: { text } },
  })
}

// 提问：把文字或图片附加到输入框上方，由用户自己输入问题
async function ask() {
  const { text, image } = toolbar.value
  try {
    if (image) {
      busy.value = true
      await captureStore.addPendingImage(image)
    }
    else {
      captureStore.pendingQuote = text
    }
    captureStore.hideToolbar()
    openChat()
  }
  catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error)
  }
  finally {
    busy.value = false
  }
}

onMounted(() => {
  captureStore.init()
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
      class="capture-toolbar"
      :style="{ left: `${position.left}px`, top: `${position.top}px` }"
      @pointerenter="onPointerEnter"
      @pointerleave="onPointerLeave"
    >
      <template v-if="hasContent">
        <div class="preview">
          <img v-if="isImage" class="preview-image" :src="toolbar.image" alt="截图预览" @load="updatePosition" />
          <template v-else>
            <p class="preview-text">{{ toolbar.text }}</p>
            <span class="preview-count">{{ toolbar.text.length }} 字</span>
          </template>
          <button class="close" title="关闭（Esc）" @click="captureStore.hideToolbar()">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>

        <div class="actions">
          <button
            v-for="action in actions"
            :key="action.id"
            class="action"
            :class="{ recommended: action.id === 'code' && looksLikeCode }"
            :disabled="chatStore.isStreaming || busy"
            :title="chatStore.isStreaming ? '正在回复中，请稍候' : action.prompt"
            @click="runAction(action)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="action.icon" /></svg>
            {{ action.label }}
          </button>
          <button class="action ask" :disabled="busy" :title="isImage ? '针对这张图片提问' : '针对这段文字提问'" @click="ask">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
            </svg>
            提问
          </button>
        </div>

        <p v-if="actionError" class="action-error">{{ actionError }}</p>
      </template>

      <p v-else class="message">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5m0 3.5v.5M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z" /></svg>
        {{ toolbar.message }}
      </p>
    </div>
  </Transition>
</template>

<style scoped src="../css/CaptureToolbar.css"></style>
