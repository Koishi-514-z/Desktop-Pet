import { createQueue, createParallelSequencedQueue, type HandlerContext } from "@/utils/queue"
import type { GeneratedAudioFile } from "ai"
import { ref } from "vue"

// 匹配形如 <happy> 或 <END/> 的标记，捕获其标签名
const EMOTION_TAG_REGEX = /<(\w+)\/?>/

// 与 EMOTION_TAG_REGEX 相同，但带 g 标志，用于从文本中移除所有标记
export const EMOTION_TAG_REGEX_GLOBAL = /<(\w+)\/?>/g

// 用于显示的宽松匹配：兼容闭合标记 </happy> 与带空格的 < happy >
const DISPLAY_TAG_REGEX = /<\s*\/?\s*\w+\s*\/?\s*>/g
// 流式输出时文本末尾尚未接收完整的标记，如 "<hap"、"</"
const PARTIAL_TAG_AT_END_REGEX = /<\s*\/?\s*\w*\s*\/?\s*$/

/**
 * 去掉文本中的情绪标记，供字幕等界面显示使用。
 * streaming 为 true 时，一并去掉末尾还没接收完整的半截标记
 */
export function stripEmotionTags(text: string, streaming = false): string {
  let result = text.replace(DISPLAY_TAG_REGEX, '')
  if (streaming) result = result.replace(PARTIAL_TAG_AT_END_REGEX, '')
  return result
}

// 标记消息回复结束的终止标记
const END_TAG = '<END/>'

// 在 speechGeneratingQueue / audioPlayingQueue 中流转的条目：
// 'speech' 为待合成语音的文本，'emotion'/'end' 为情绪标记/结束标记，
// 二者会按原始顺序依次向下传递，最终在 audioPlayingQueue 中处理
export type SpeechQueueItem =
  | { type: 'speech', text: string }
  | { type: 'emotion', emotion: string }
  | { type: 'end' }

// speechGeneratingQueue 的输出：'speech' 文本会被替换为合成后的音频，
// 'emotion'/'end' 标记原样传递
export type PlaybackItem =
  | { type: 'audio', audio: GeneratedAudioFile }
  | { type: 'emotion', emotion: string }
  | { type: 'end' }

// 句末标点，用于将文本切分为完整语句后再输出，避免下游（如语音合成）收到语义不完整的片段
const SENTENCE_END_REGEX = /[。！？；…!?;]/

// 文本处理队列：将流式接收到的文本按 <Emotion> 标记切分，
// 再按句末标点将文本切分为完整语句，依次 emit 'text'（完整语句）与 'emotion'（标记中的情绪名称）事件。
// 检测到终止标记后，输出剩余的所有文本（无论是否构成完整语句）并 emit 'end'；
export function useTextProcessingQueue() {
  // 尚未处理的文本缓冲区，可能包含不完整的标记
  const buffer = ref('')

  // 已确定不属于标记、但尚未凑成完整语句的文本缓冲区
  const sentenceBuffer = ref('')

  // 按句末标点切分 sentenceBuffer 并依次 emit('text', ...)；
  // force 为 true 时，连同末尾不完整的部分一起输出
  function flushSentences(emit: (eventName: string, ...params: any[]) => void, force: boolean) {
    let text = sentenceBuffer.value
    let match = text.match(SENTENCE_END_REGEX)
    while (match) {
      const end = match.index! + match[0].length
      emit('text', text.slice(0, end))
      text = text.slice(end)
      match = text.match(SENTENCE_END_REGEX)
    }

    if (force && text) {
      emit('text', text)
      text = ''
    }

    sentenceBuffer.value = text
  }

  const queue = createQueue<string>({
    handlers: [
      async ({ data, emit }) => {
        buffer.value += data

        // 不断从缓冲区中提取完整的 <Emotion> 标记
        let match = buffer.value.match(EMOTION_TAG_REGEX)
        while (match) {
          const tagStart = match.index!
          const tagEnd = tagStart + match[0]!.length
          const tagContent = match[1]!

          // 之前的文本片段
          const segment = buffer.value.slice(0, tagStart)
          sentenceBuffer.value += segment

          if (tagContent === 'END') {
            // 终止标记：输出剩余的所有文本并结束本次回复
            flushSentences(emit, true)
            emit('end')
          }
          else {
            // 普通情绪标记：按句末标点输出完整语句，再输出情绪标记本身
            flushSentences(emit, false)
            emit('emotion', tagContent)
          }

          buffer.value = buffer.value.slice(tagEnd)
          match = buffer.value.match(EMOTION_TAG_REGEX)
        }
      },
    ],
  })

  function enQueue(text: string) {
    queue.enqueue(text)
  }

  function onTextProcessed(callback: (text: string) => void) {
    queue.onHandlerEvent('text', callback)
  }

  function onEmotionProcessed(callback: (emotion: string) => void) {
    queue.onHandlerEvent('emotion', callback)
  }

  function onEndProcessed(callback: () => void) {
    queue.onHandlerEvent('end', callback)
  }

  function endQueue() {
    queue.enqueue(END_TAG)
  }

  function resetQueue() {
    queue.clear()
    buffer.value = ''
    sentenceBuffer.value = ''
  }

  return {
    enQueue,
    onTextProcessed,
    onEmotionProcessed,
    onEndProcessed,
    endQueue,
    resetQueue,
  }
}

// 语音合成队列：接收 textProcessingQueue 产出的条目，
// 'speech' 文本经语音合成后转换为 'audio'，'emotion'/'end' 标记原样传递，
// 处理为并行进行，但输出按入队顺序依次传递给 audioPlayingQueue
export function useSpeechGeneratingQueue() {
  const queue = createParallelSequencedQueue<SpeechQueueItem, PlaybackItem>({})

  function enQueue(item: SpeechQueueItem) {
    queue.enqueue(item)
  }

  function onItemReceived(handler: (ctx: HandlerContext<SpeechQueueItem>) => Promise<PlaybackItem>) {
    queue.setProcessor(handler)
  }

  function onItemGenerated(handler: (ctx: HandlerContext<PlaybackItem> & { sequence: number, originalData: SpeechQueueItem }) => Promise<void>) {
    queue.setOutputHandler(handler)
  }

  function resetQueue() {
    queue.reset()
  }

  return {
    enQueue,
    onItemReceived,
    onItemGenerated,
    resetQueue,
  }
}

// 音频播放队列：依次播放音频，并在情绪/结束标记到达时按顺序处理（如切换表情/动作）
export function useAudioPlayingQueue() {
  const queue = createQueue<PlaybackItem>({
    handlers: [],
  })

  function enQueue(data: PlaybackItem) {
    queue.enqueue(data)
  }

  function onItemReceived(handler: (ctx: HandlerContext<PlaybackItem>) => Promise<void>) {
    queue.addHandler(handler)
  }

  function resetQueue() {
    queue.clear()
  }

  return {
    enQueue,
    onItemReceived,
    resetQueue,
  }
}
