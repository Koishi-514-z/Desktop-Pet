<script setup lang="ts">
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


chatStore.onStart(async () => {
  textProcessingQueue.resetQueue()
  speechGeneratingQueue.resetQueue()
  audioPlayingQueue.resetQueue()
  live2dStore.playExpressionByTag('thinking')
})

chatStore.onFirstChunkArrived(async () => {
  live2dStore.playDefaultExpression()
})

chatStore.onChunk(async (delta: string) => {
  textProcessingQueue.enQueue(delta)
})

chatStore.onFinish(async () => {
  textProcessingQueue.endQueue()
})

chatStore.onError(async (error: unknown) => {
  console.error(error)
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


speechStore.onError(async (error: unknown) => {
  console.error(error)
})

speechGeneratingQueue.onItemReceived(async ({ data }) => {
  if (data.type !== 'speech') return data

  const audio = await speechStore.speak(data.text)
  if (!audio) {
    throw new Error('Failed to generate speech')
  }
  return { type: 'audio', audio }
})

speechGeneratingQueue.onItemGenerated(async ({ data }) => {
  audioPlayingQueue.enQueue(data)
})


audioStore.onError(async (error: unknown) => {
  console.error(error)
})

audioPlayingQueue.onItemReceived(async ({ data }) => {
  console.log('audioPlayingQueue.onItemReceived', data)

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
  <main>
    <Live2dModel />
  </main>
</template>