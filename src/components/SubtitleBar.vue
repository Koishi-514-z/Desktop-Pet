<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useAudioStore } from '@/stores/audio'
import { useChatStore } from '@/stores/chat'
import { usePersonaStore } from '@/stores/persona'
import { useSceneStore } from '@/stores/scene'
import { useDesktopCursor } from '@/composables/desktop'
import { stripEmotionTags } from '@/composables/queues'

const chatStore = useChatStore()
const personaStore = usePersonaStore()
const sceneStore = useSceneStore()
const audioStore = useAudioStore()
const desktopCursor = useDesktopCursor()

// 字幕只在非空消息之间切换（流式回复的占位消息在收到首个字符前为空，不予显示；
// 只有情绪标记、去掉后没有正文的消息同样视为空）
const messages = computed(() =>
  chatStore.visibleMessages.filter((message) => {
    const text = message.role === 'user' ? message.content : stripEmotionTags(message.content, true)
    return text.trim() !== ''
  }),
)

// 用户手动选中的消息下标；为 null 时表示跟随最新一条消息
const selectedIndex = ref<number | null>(null)
// 切换方向，决定切换动画是从上方还是下方进入
const direction = ref<'older' | 'newer'>('newer')

const following = computed(() => selectedIndex.value === null)

// 当前实际显示的消息下标（消息被删除时自动夹紧到有效范围内）
const displayIndex = computed(() => {
  const last = messages.value.length - 1
  return selectedIndex.value === null ? last : Math.min(selectedIndex.value, last)
})

const currentMessage = computed(() => messages.value[displayIndex.value])

// 当前显示的是否为正在流式生成的那条消息
const isLive = computed(
  () =>
    chatStore.isStreaming &&
    !!currentMessage.value &&
    currentMessage.value === chatStore.visibleMessages.at(-1),
)

// 桌宠的回复去掉情绪标记后再显示（流式生成中还会去掉末尾未接收完整的半截标记）；用户消息原样显示
const displayText = computed(() => {
  const message = currentMessage.value
  if (!message) return ''
  const text = message.role === 'user' ? message.content : stripEmotionTags(message.content, isLive.value)
  return text.trim()
})

const speakerName = computed(() =>
  currentMessage.value?.role === 'user' ? '我' : (personaStore.currentPersona?.name ?? '桌宠'),
)

const canGoOlder = computed(() => displayIndex.value > 0)
const canGoNewer = computed(() => displayIndex.value < messages.value.length - 1)

function goOlder() {
  if (!canGoOlder.value) return
  direction.value = 'older'
  selectedIndex.value = displayIndex.value - 1
}

function goNewer() {
  if (!canGoNewer.value) return
  direction.value = 'newer'
  const next = displayIndex.value + 1
  // 切回最后一条时恢复跟随模式
  selectedIndex.value = next >= messages.value.length - 1 ? null : next
}

function backToLatest() {
  if (following.value) return
  direction.value = 'newer'
  selectedIndex.value = null
}

// 有新消息或切换会话时，回到跟随最新消息
watch(
  () => messages.value.length,
  (length, oldLength) => {
    if (length > oldLength) {
      direction.value = 'newer'
      selectedIndex.value = null
    }
  },
)
watch(
  () => chatStore.currentSession?.id,
  () => {
    direction.value = 'newer'
    selectedIndex.value = null
  },
)

// 字幕文本区域：内容过长时可滚动，跟随模式下自动滚动到底部
const textWrapper = ref<HTMLElement>()

function scrollText(toBottom: boolean) {
  const el = textWrapper.value?.querySelector<HTMLElement>('.subtitle-text')
  if (!el) return
  el.scrollTop = toBottom ? el.scrollHeight : 0
}

function onTextEnter() {
  scrollText(following.value)
}

watch(displayText, () => {
  if (following.value) nextTick(() => scrollText(true))
})

// ===== 显示与隐藏：只在桌宠说话时显示，说完一段时间后自动隐藏 =====

// 隐藏的时间到了、鼠标却还停在字幕上（在看、或者在翻之前的消息）时，隔多久再看一次
const HOVER_RECHECK_MS = 1500

// 桌宠正在说话：正在流式输出回复（已经出现文字；思考、调用工具时还没开口不算），或者正在播放语音。
// 语音通常在文字生成完之后还会播一会儿，句子之间短暂的空档由隐藏前的等待时间盖过去
const speaking = computed(() => {
  if (audioStore.isPlaying) return true
  const latest = messages.value.at(-1)
  return chatStore.isStreaming && latest?.role === 'assistant' && latest === chatStore.visibleMessages.at(-1)
})

// 是否处于显示状态：开始说话时打开，说完并等待设定的时间后关闭
const active = ref(false)
let hideTimer: ReturnType<typeof setTimeout> | undefined

const cardRef = ref<HTMLElement>()

// 鼠标是否停在字幕上。桌面窗口平时是鼠标穿透的，移出字幕时网页不一定收得到 mouseleave，
// 因此有全局鼠标坐标时以它为准
function isHovering(): boolean {
  const card = cardRef.value
  if (!card) return false
  const cursor = desktopCursor.value
  if (!cursor) return card.matches(':hover')
  const rect = card.getBoundingClientRect()
  return cursor.x >= rect.left && cursor.x <= rect.right && cursor.y >= rect.top && cursor.y <= rect.bottom
}

function clearHideTimer() {
  if (hideTimer === undefined) return
  clearTimeout(hideTimer)
  hideTimer = undefined
}

function scheduleHide(delay: number) {
  clearHideTimer()
  hideTimer = setTimeout(() => {
    hideTimer = undefined
    // 又开始说话了：等说完再重新计时
    if (speaking.value) return
    if (isHovering()) {
      scheduleHide(HOVER_RECHECK_MS)
      return
    }
    active.value = false
  }, delay)
}

watch(
  speaking,
  (value) => {
    if (value) {
      clearHideTimer()
      active.value = true
    }
    else if (active.value) {
      scheduleHide(Math.max(0, sceneStore.subtitleHideDelay) * 1000)
    }
  },
  { immediate: true },
)

onBeforeUnmount(clearHideTimer)

// 跟随最新消息时，最新的是用户刚发出的消息：桌宠还没开口，先不显示（手动翻看之前的消息时照常显示）
const waitingReply = computed(() => following.value && currentMessage.value?.role === 'user')

const visible = computed(() => sceneStore.showSubtitle && !!currentMessage.value && active.value && !waitingReply.value)
</script>

<template>
  <Transition name="subtitle-fade">
    <div v-if="visible && currentMessage" class="subtitle">
      <div ref="cardRef" class="subtitle-card" :class="currentMessage.role">
        <div class="speaker">
          <span class="speaker-name">{{ speakerName }}</span>
          <span v-if="isLive" class="live-dot" title="正在回复"></span>
        </div>

        <div ref="textWrapper" class="subtitle-body">
          <Transition :name="`subtitle-slide-${direction}`" mode="out-in" @enter="onTextEnter">
            <!-- prettier-ignore -->
            <p :key="`${chatStore.currentSession?.id}-${displayIndex}`" class="subtitle-text">{{ displayText }}<span v-if="isLive" class="caret"></span></p>
          </Transition>
        </div>

        <nav class="subtitle-nav">
          <button
            class="nav-button"
            title="上一条"
            :disabled="!canGoOlder"
            @click="goOlder"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg>
          </button>
          <button
            class="counter"
            :class="{ detached: !following }"
            :title="following ? '当前为最新消息' : '回到最新消息'"
            @click="backToLatest"
          >
            {{ displayIndex + 1 }}<span class="sep">/</span>{{ messages.length }}
          </button>
          <button
            class="nav-button"
            title="下一条"
            :disabled="!canGoNewer"
            @click="goNewer"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
          </button>
        </nav>
      </div>
    </div>
  </Transition>
</template>

<style scoped src="../css/SubtitleBar.css"></style>
