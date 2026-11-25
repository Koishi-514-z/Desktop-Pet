<script setup lang="ts">
import { onBeforeUnmount } from 'vue'
import Live2dModel from '@/components/Live2dModel.vue'
import { useTextProcessingQueue, useSpeechGeneratingQueue, useAudioPlayingQueue } from '@/composables/queues'
import { useChatStore } from '@/stores/chat';
import { useSpeechStore } from '@/stores/speech';
import { useAudioStore } from '@/stores/audio';
import { useLive2dStore } from '@/stores/live2d';
import { randBool } from '@/utils/math';

const chatStore = useChatStore()
const textProcessingQueue = useTextProcessingQueue()
const speechStore = useSpeechStore()
const speechGeneratingQueue = useSpeechGeneratingQueue()
const audioStore = useAudioStore()
const audioPlayingQueue = useAudioPlayingQueue()
const live2dStore = useLive2dStore()

// 向全局 store 注册的钩子在卸载时全部注销：store 是单例，组件重新挂载（如开发时的热更新）后，
// 旧组件的钩子若还在，就会驱动旧的一套队列，同一句话被重复合成、重复播放
const disposers = [
  chatStore.onStart(async () => {
    textProcessingQueue.resetQueue()
    speechGeneratingQueue.resetQueue()
    audioPlayingQueue.resetQueue()
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
  // 丢弃这一套队列中尚未处理的内容，并停止它正在播放的语音
  textProcessingQueue.resetQueue()
  speechGeneratingQueue.resetQueue()
  audioPlayingQueue.resetQueue()
  audioStore.stop()
})

textProcessingQueue.onTextProcessed((text: string) => {
  speechGeneratingQueue.enQueue({ type: 'speech', text })
})

textProcessingQueue.onEmotionProcessed((emotion: string) => {
  speechGeneratingQueue.enQueue({ type: 'emotion', emotion })
})

textProcessingQueue.onEndProcessed(() => {
  speechGeneratingQueue.enQueue({ type: 'end' })
})


speechGeneratingQueue.onItemReceived(async ({ data }) => {
  if (data.type !== 'speech') return data

  const audio = await speechStore.speak(data.text)
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
    case 'emotion':
      if (data.emotion === 'neutral') break
      if (randBool(0.5)) {
        live2dStore.playExpressionByTag(data.emotion)
      }
      else {
        live2dStore.playMotionByTag(data.emotion)
      }
      break
    case 'end':
      live2dStore.playDefaultExpression()
      break
  }
})
</script>

<template>
  <main data-passthrough>
    <Live2dModel />
  </main>
</template>
