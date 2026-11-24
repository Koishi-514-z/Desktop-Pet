<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useChatStore } from '@/stores/chat'
import { usePersonaStore } from '@/stores/persona'
import { useSceneStore } from '@/stores/scene'
import { stripEmotionTags } from '@/composables/queues'

const chatStore = useChatStore()
const personaStore = usePersonaStore()
const sceneStore = useSceneStore()

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
</script>

<template>
  <Transition name="subtitle-fade">
    <div v-if="sceneStore.showSubtitle && currentMessage" class="subtitle">
      <div class="subtitle-card" :class="currentMessage.role">
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
