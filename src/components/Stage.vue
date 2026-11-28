<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import Live2dModel from '@/components/Live2dModel.vue'
import {
  useTextProcessingQueue,
  useSpeechGeneratingQueue,
  useAudioPlayingQueue,
  useVoiceDetectingQueue,
  useTranscriptionQueue,
} from '@/composables/queues'
import { useChatStore } from '@/stores/chat';
import { useSpeechStore } from '@/stores/speech';
import { useAudioStore } from '@/stores/audio';
import { useLive2dStore } from '@/stores/live2d';
import { useLanguageStore } from '@/stores/language'
import { useMicrophoneStore } from '@/stores/microphone'
import { useTranscriptionStore } from '@/stores/transcription'
import { randBool } from '@/utils/math';

// 语音管线（见 composables/queues.ts）：
// 输入：麦克风 → 检测出一句句话 → 语音识别 → 发送给对话
// 输出：对话的流式回复 → 切分语句 → 语音合成 → 依次播放
const microphoneStore = useMicrophoneStore()
const voiceDetectingQueue = useVoiceDetectingQueue()
const transcriptionStore = useTranscriptionStore()
const transcriptionQueue = useTranscriptionQueue()
const chatStore = useChatStore()
const textProcessingQueue = useTextProcessingQueue()
const speechStore = useSpeechStore()
const speechGeneratingQueue = useSpeechGeneratingQueue()
const audioStore = useAudioStore()
const audioPlayingQueue = useAudioPlayingQueue()
const live2dStore = useLive2dStore()
const languageStore = useLanguageStore()

// ===== 输入：语音识别 =====

// 桌宠说完话后，再等一会儿才接着听，免得把自己声音的尾巴当成用户说的话
const ECHO_GUARD_MS = 400
// 识别出一句话后稍等一下再发送：这期间用户接着说的话会合并成一条消息
const SEND_DELAY_MS = 400

// 桌宠正在说话（正在播放，或者这一轮还有语音没播完）时不听，避免把自己的声音识别成用户说的话
const petSpeaking = computed(() => audioStore.isPlaying || audioStore.speechPending)
let listenAfter = 0

// 识别出来、还没发送的文字，以及还没识别完的句数
let draft = ''
let transcribing = 0
let sendTimer: ReturnType<typeof setTimeout> | undefined

// 把识别出的几句话接起来：前后都是英文单词时用空格隔开，中文直接接上
function joinTranscript(previous: string, next: string): string {
  if (!previous) return next
  return /[A-Za-z0-9]$/.test(previous) && /^[A-Za-z0-9]/.test(next) ? `${previous} ${next}` : previous + next
}

function cancelSend() {
  clearTimeout(sendTimer)
  sendTimer = undefined
}

// 用户说完、已经说的话都识别完了，才把攒下的文字作为一条消息发出去
function scheduleSend() {
  cancelSend()
  if (!draft || transcribing > 0 || voiceDetectingQueue.isSpeaking()) return
  sendTimer = setTimeout(() => {
    sendTimer = undefined
    const content = draft
    draft = ''
    void chatStore.sendMessage(content)
  }, SEND_DELAY_MS)
}

// 丢掉正在听的这句话；之前已经说完的照常识别、发送
function resetListening() {
  voiceDetectingQueue.resetQueue()
  microphoneStore.userSpeaking = false
  scheduleSend()
}

watch(petSpeaking, (speaking) => {
  if (speaking) resetListening()
  else listenAfter = performance.now() + ECHO_GUARD_MS
})

// 打开麦克风时重新测量环境噪声；关闭时丢掉正在听的这句话
watch(() => microphoneStore.isListening, (listening) => {
  if (listening) voiceDetectingQueue.resetQueue({ recalibrate: true })
  else resetListening()
})

// 向全局 store 注册的钩子在卸载时全部注销：store 是单例，组件重新挂载（如开发时的热更新）后，
// 旧组件的钩子若还在，就会驱动旧的一套队列，同一句话被重复合成、重复播放
const disposers = [
  microphoneStore.onFrame((frame: Float32Array) => {
    if (petSpeaking.value || performance.now() < listenAfter) return
    voiceDetectingQueue.enQueue(frame)
  }),

  transcriptionStore.onError(async (error: unknown) => {
    console.error(error)
  }),

  chatStore.onStart(async () => {
    resetSpeechTurn()
    textProcessingQueue.resetQueue()
    speechGeneratingQueue.resetQueue()
    audioPlayingQueue.resetQueue()
    // 新的一轮回复开始：上一轮还没播的语音已经丢弃
    audioStore.speechPending = false
    live2dStore.playExpressionByTag('thinking')
  }),

  chatStore.onFirstChunkArrived(async () => {
    live2dStore.playDefaultExpression()
  }),

  chatStore.onChunk(async (delta: string) => {
    textProcessingQueue.enQueue(delta)
  }),

  chatStore.onFinish(async () => {
    textProcessingQueue.endQueue()
  }),

  chatStore.onError(async (error: unknown) => {
    console.error(error)
    // 回复中途出错时同样结束这一轮：已经送去合成的语音照常播完，最后发出结束标记
    // （否则一直等不到结束标记，字幕也就一直不会隐藏）
    textProcessingQueue.endQueue()
  }),

  chatStore.onInterrupt(async () => {
    // 打断：还没说的话全部丢掉（正在翻译、合成的语音完成后也会被丢弃），停止正在播放的这一句
    resetSpeechTurn()
    textProcessingQueue.resetQueue()
    speechGeneratingQueue.resetQueue()
    audioPlayingQueue.resetQueue()
    audioStore.stop()
    audioStore.speechPending = false
    live2dStore.playDefaultExpression()
  }),

  speechStore.onError(async (error: unknown) => {
    console.error(error)
  }),

  audioStore.onError(async (error: unknown) => {
    console.error(error)
  }),
]

onBeforeUnmount(() => {
  disposers.forEach((dispose) => dispose())
  // 丢弃这一套队列中尚未处理的内容，并停止它正在播放的语音（麦克风是全局的，保持打开）
  voiceDetectingQueue.resetQueue()
  transcriptionQueue.resetQueue()
  cancelSend()
  microphoneStore.userSpeaking = false
  resetSpeechTurn()
  textProcessingQueue.resetQueue()
  speechGeneratingQueue.resetQueue()
  audioPlayingQueue.resetQueue()
  audioStore.stop()
  audioStore.speechPending = false
})

voiceDetectingQueue.onSpeechStarted(() => {
  microphoneStore.userSpeaking = true
  cancelSend()
})

voiceDetectingQueue.onUtteranceDetected((utterance) => {
  transcribing++
  transcriptionQueue.enQueue(utterance)
})

voiceDetectingQueue.onSpeechEnded(() => {
  microphoneStore.userSpeaking = false
  // 太短被当作杂音丢掉时，也要把之前攒下的文字发出去
  scheduleSend()
})

transcriptionQueue.onItemReceived(async ({ data }) => {
  try {
    const text = await transcriptionStore.transcribe(data.audio)
    if (!text) throw new Error('没有识别出文字')
    return text
  }
  catch (error) {
    // 这一句会被跳过，不会再输出
    transcribing--
    scheduleSend()
    throw error
  }
})

transcriptionQueue.onItemTranscribed(async ({ data }) => {
  transcribing--
  draft = joinTranscript(draft, data)
  scheduleSend()
})

// ===== 输出：语音合成与播放 =====

// 这一轮回复中已经送去合成的文字（念的语言与显示的不同时，作为翻译的前文）
let spokenText = ''
// 取消这一轮还没完成的翻译请求（新的一轮开始、打断、卸载时）
let speechController = new AbortController()

function resetSpeechTurn() {
  spokenText = ''
  speechController.abort()
  speechController = new AbortController()
}

textProcessingQueue.onTextProcessed((text: string) => {
  // 有话要说了：直到结束标记在播放队列中被处理之前，都算还有语音没播完
  audioStore.speechPending = true
  speechGeneratingQueue.enQueue({ type: 'speech', text, context: spokenText })
  spokenText += text
})

textProcessingQueue.onEmotionProcessed((emotion: string) => {
  speechGeneratingQueue.enQueue({ type: 'emotion', emotion })
})

textProcessingQueue.onEndProcessed(() => {
  speechGeneratingQueue.enQueue({ type: 'end' })
})


speechGeneratingQueue.onItemReceived(async ({ data }) => {
  if (data.type !== 'speech') return data

  // 语音合成服务商不理解情绪标签时先去掉标签；去掉后只剩下标点（如单独的一个 [sighs]）时没有要念的，跳过这一句
  const speakable = speechStore.toSpeakableText(data.text)
  if (!/[\p{L}\p{N}]/u.test(speakable)) throw new Error('这句话没有要念的内容')

  // 念的语言与显示的不同时，先翻译成要念的语言（屏幕上仍显示原文）
  const text = await languageStore.toSpeechText(speakable, { context: data.context, abortSignal: speechController.signal })
  const audio = await speechStore.speak(text)
  if (!audio) {
    throw new Error('Failed to generate speech')
  }
  return { type: 'audio', audio }
})

speechGeneratingQueue.onItemGenerated(async ({ data, sequence, originalData }) => {
  console.log('speechGeneratingQueue.onItemGenerated', sequence, originalData)
  audioPlayingQueue.enQueue(data)
})


audioPlayingQueue.onItemReceived(async ({ data }) => {
  switch (data.type) {
    case 'audio':
      await audioStore.play(data.audio)
      break
    case 'emotion': {
      // 随机换一个带有同名标签的表情或做一个动作；随机到的那一类里没有这个标签时（如只给表情打了标签）换另一类。
      // 都没有（如停顿、说话方式类的标签）时什么也不做
      const tag = data.emotion
      if (randBool(0.5)) {
        if (!live2dStore.playExpressionByTag(tag)) live2dStore.playMotionByTag(tag)
      }
      else if (!live2dStore.playMotionByTag(tag)) {
        live2dStore.playExpressionByTag(tag)
      }
      break
    }
    case 'end':
      live2dStore.playDefaultExpression()
      // 结束标记排在这一轮所有语音之后：到这里语音已经全部播完（合成失败的句子会被跳过）
      audioStore.speechPending = false
      break
  }
})
</script>

<template>
  <main data-passthrough>
    <Live2dModel />
  </main>
</template>
