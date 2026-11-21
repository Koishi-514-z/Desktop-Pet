<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useChatStore } from '@/stores/chat'
import { useSceneStore } from '@/stores/scene'

const chatStore = useChatStore()
const sceneStore = useSceneStore()

const inputText = ref('')
const errorMessage = ref('')
const messagesContainer = ref<HTMLElement>()

const state = computed(() => sceneStore.interactiveAreaState)

// 拖拽状态
const dragging = ref(false)
const dragOffset = ref({ x: 0, y: 0 })

const panelStyle = computed(() => ({
  left: `${state.value.position.x}px`,
  top: `${state.value.position.y}px`,
}))

function startDrag(event: PointerEvent) {
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

// 当前会话的最后一条消息内容，流式响应时会持续变化，用于触发自动滚动
const lastMessageContent = computed(() => chatStore.visibleMessages.at(-1)?.content)

function scrollToBottom() {
  const el = messagesContainer.value
  if (!el) return
  el.scrollTop = el.scrollHeight
}

watch([() => chatStore.visibleMessages.length, lastMessageContent], () => nextTick(scrollToBottom))
watch(() => chatStore.currentSessionId, () => nextTick(scrollToBottom))

// 发送当前输入框中的内容
async function handleSend() {
  const content = inputText.value.trim()
  if (!content || chatStore.isStreaming) return

  inputText.value = ''
  errorMessage.value = ''
  await chatStore.sendMessage(content)
}

// Enter 发送，Shift+Enter 换行
function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    handleSend()
  }
}

chatStore.onError(async (error) => {
  errorMessage.value = error instanceof Error ? error.message : String(error)
})

onMounted(() => {
  state.value.position = { x: window.innerWidth - 444, y: window.innerHeight - 608 }
})

</script>

<template>
  <button class="toggle-button" :title="state.visible ? '收起对话' : '打开对话'" @click="state.visible = !state.visible">
    {{ state.visible ? '×' : '💬' }}
  </button>

  <div v-show="state.visible" class="interactive-area" :style="panelStyle">
    <header class="panel-header" @pointerdown="startDrag">
      <span class="panel-title">对话</span>
      <button class="close-button" title="关闭" @click="state.visible = false">
        ×
      </button>
    </header>

    <div class="panel-body">
      <aside class="session-list">
        <button class="new-session" @click="chatStore.createNewSession()">
          + 
        </button>

        <ul>
          <li
            v-for="session in chatStore.sessions"
            :key="session.id"
            class="session-item"
            :class="{ active: session.id === chatStore.currentSessionId }"
            @click="chatStore.switchSession(session.id)"
          >
            <span class="title">{{ session.title }}</span>
            <button class="remove" title="删除会话" @click.stop="chatStore.removeSession(session.id)">
              ×
            </button>
          </li>
        </ul>
      </aside>

      <section class="chat-panel">
        <div ref="messagesContainer" class="messages">
          <p v-if="chatStore.visibleMessages.length === 0" class="empty-hint">
            说点什么开始对话吧
          </p>

          <div
            v-for="(message, index) in chatStore.visibleMessages"
            :key="index"
            class="message"
            :class="message.role"
          >
            <div class="bubble">
              <span v-if="message.content">{{ message.content }}</span>
              <span v-else-if="chatStore.isStreaming && index === chatStore.visibleMessages.length - 1" class="typing">
                <i></i><i></i><i></i>
              </span>
            </div>
          </div>
        </div>

        <p v-if="errorMessage" class="error">
          {{ errorMessage }}
        </p>

        <form class="input-area" @submit.prevent="handleSend">
          <textarea
            v-model="inputText"
            class="input"
            placeholder="输入消息，Enter 发送，Shift + Enter 换行"
            rows="2"
            @keydown="handleKeydown"
          />
          <button class="send" type="submit" :disabled="!inputText.trim() || chatStore.isStreaming">
            发送
          </button>
        </form>
      </section>
    </div>
  </div>
</template>

<style scoped src="../css/InteractiveArea.css"></style>
