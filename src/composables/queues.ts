import { createQueue, createParallelSequencedQueue, type HandlerContext } from "@/utils/queue"
import type { GeneratedAudioFile } from "ai"
import { ref } from "vue"
import { encodeWav, VOICE_SAMPLE_RATE, VoiceActivityDetector, type VoiceActivityOptions } from "@/utils/voice-activity"
import { EMOTION_TAG_REGEX, normalizeEmotionTag, stripEmotionTags } from "@/utils/emotion-tags"

/**
 * 桌宠的语音管线（由 Stage 组装）：
 *
 * 输入：麦克风 → voiceDetectingQueue（检测出一句句话）→ transcriptionQueue（并行识别、按顺序输出文字）→ 发送给对话
 * 输出：对话的流式回复 → textProcessingQueue（切分语句与情绪标记）→ speechGeneratingQueue（并行合成、按顺序输出语音）
 *      → audioPlayingQueue（依次播放，处理情绪与结束标记）
 */

// ===== 输入：语音识别 =====

// 一句话的录音：16 kHz 单声道 WAV
export interface Utterance {
  audio: Uint8Array
  durationMs: number
}

// 语音检测队列：接收麦克风的一帧帧声音，从中检测出一句一句的话，依次 emit
// 'speech-start'（开始说话）、'utterance'（说完的一句话，已编码为 WAV）与 'speech-end'（这句话结束，
// 太短被当作杂音丢掉时也会 emit）事件
export function useVoiceDetectingQueue(options?: VoiceActivityOptions) {
  const detector = new VoiceActivityDetector(options)

  const queue = createQueue<Float32Array>({
    handlers: [
      async ({ data, emit }) => {
        const wasSpeaking = detector.speaking
        const samples = detector.push(data)
        if (!wasSpeaking && detector.speaking) emit('speech-start')
        if (samples) {
          const utterance: Utterance = { audio: encodeWav(samples), durationMs: samples.length / VOICE_SAMPLE_RATE * 1000 }
          emit('utterance', utterance)
        }
        if (wasSpeaking && !detector.speaking) emit('speech-end')
      },
    ],
  })

  function enQueue(frame: Float32Array) {
    queue.enqueue(frame)
  }

  function onSpeechStarted(callback: () => void) {
    queue.onHandlerEvent('speech-start', callback)
  }

  function onUtteranceDetected(callback: (utterance: Utterance) => void) {
    queue.onHandlerEvent('utterance', callback)
  }

  function onSpeechEnded(callback: () => void) {
    queue.onHandlerEvent('speech-end', callback)
  }

  // 是否正在说一句话
  function isSpeaking() {
    return detector.speaking
  }

  // 丢掉还没处理的声音与正在检测的这句话（不会 emit 'speech-end'）；recalibrate 时重新测量环境噪声
  function resetQueue(options: { recalibrate?: boolean } = {}) {
    queue.clear()
    if (options.recalibrate) detector.recalibrate()
    else detector.reset()
  }

  return {
    enQueue,
    onSpeechStarted,
    onUtteranceDetected,
    onSpeechEnded,
    isSpeaking,
    resetQueue,
  }
}

// 语音识别队列：接收 voiceDetectingQueue 产出的一句句话，并行识别，但按说话的顺序输出文字；
// 处理函数抛出异常（识别失败、没有识别出文字）时跳过这一句
export function useTranscriptionQueue() {
  const queue = createParallelSequencedQueue<Utterance, string>({})

  function enQueue(item: Utterance) {
    queue.enqueue(item)
  }

  function onItemReceived(handler: (ctx: HandlerContext<Utterance>) => Promise<string>) {
    queue.setProcessor(handler)
  }

  function onItemTranscribed(handler: (ctx: HandlerContext<string> & { sequence: number, originalData: Utterance }) => Promise<void>) {
    queue.setOutputHandler(handler)
  }

  function resetQueue() {
    queue.reset()
  }

  return {
    enQueue,
    onItemReceived,
    onItemTranscribed,
    resetQueue,
  }
}

// ===== 输出：语音合成与播放 =====

// 回复结束的标记：由 endQueue 放进文本处理队列，不与回复的文字混在一起，模型输出什么都不会被当作结束
const END_OF_REPLY = Symbol('end-of-reply')

// 在 speechGeneratingQueue / audioPlayingQueue 中流转的条目：
// 'speech' 为待合成语音的文本（其中保留着情绪标签，合成前按服务商决定是否去掉），'emotion'/'end' 为情绪标签/结束标记，
// 二者会按原始顺序依次向下传递，最终在 audioPlayingQueue 中处理
export type SpeechQueueItem =
  // context：这一轮回复中这句话之前的内容，念的语言与显示的不同、需要翻译时用来保持译文连贯；
  // owner：这句话所属的回复（会话中的消息），合成的语音记在它名下，以便在字幕上收藏
  | { type: 'speech', text: string, context?: string, owner?: object }
  | { type: 'emotion', emotion: string }
  | { type: 'end' }

// speechGeneratingQueue 的输出：'speech' 文本会被替换为合成后的音频，
// 'emotion'/'end' 标记原样传递
export type PlaybackItem =
  | { type: 'audio', audio: GeneratedAudioFile }
  | { type: 'emotion', emotion: string }
  | { type: 'end' }

// 句末：句末标点，用于将文本切分为完整语句后再输出，避免下游（如语音合成）收到语义不完整的片段。
// 连续的句末标点（如「……」「？！」）算作一处，紧跟着的右引号、右括号归到这一句
const SENTENCE_END_REGEX = /[。！？；…!?;]+[”’"'」』）)\]]*/g

// 一句话去掉标点与空白后不足这么多字时不单独输出，与下一句合并：
// 避免语音合成收到「嗯。」「好的！」这样零碎的片段，读起来一顿一顿的
export const MIN_SENTENCE_LENGTH = 60

/** 句子的长度：不算情绪标签、标点、符号与空白 */
export function sentenceLength(text: string): number {
  return stripEmotionTags(text).replace(/[\s\p{P}\p{S}]/gu, '').length
}

// 文本处理队列：从流式接收到的文本中找出 [happy] 这样的情绪标签，
// 再按句末标点将文本切分为完整语句（太短的与下一句合并），依次 emit 'text'（语句）与 'emotion'（标签名，英文小写）事件。
// 标签在 emit 'emotion' 之后仍留在语句中，交给语音合成（支持标签的服务商据此调整语气、发出笑声或停顿）。
// endQueue 之后，输出剩余的所有文本（无论是否构成完整语句、是否够长）并 emit 'end'
export function useTextProcessingQueue() {
  // 尚未处理的文本缓冲区，可能包含不完整的标签
  const buffer = ref('')

  // 已确定标签完整、但尚未输出的文本缓冲区：还没凑成完整语句，或者是等着与下一句合并的短句
  const sentenceBuffer = ref('')

  // 按句末标点切分 sentenceBuffer 并依次 emit('text', ...)：够长的句子直接输出，
  // 太短的留下与下一句合并；force 为 true 时，连同剩下的部分一起输出
  function flushSentences(emit: (eventName: string, ...params: unknown[]) => void, force: boolean) {
    const text = sentenceBuffer.value
    // 已经输出到的位置
    let cut = 0
    for (const match of text.matchAll(SENTENCE_END_REGEX)) {
      const end = match.index + match[0].length
      const sentence = text.slice(cut, end)
      if (sentenceLength(sentence) < MIN_SENTENCE_LENGTH) continue
      emit('text', sentence)
      cut = end
    }

    let rest = text.slice(cut)
    if (force && rest) {
      emit('text', rest)
      rest = ''
    }

    sentenceBuffer.value = rest
  }

  const queue = createQueue<string | typeof END_OF_REPLY>({
    handlers: [
      async ({ data, emit }) => {
        if (data !== END_OF_REPLY) buffer.value += data

        // 不断从缓冲区中提取完整的标签
        let match = buffer.value.match(EMOTION_TAG_REGEX)
        while (match) {
          const tagStart = match.index!
          const tag = normalizeEmotionTag(match[1]!)

          // 按句末标点输出标签之前已经完整的语句，再输出标签本身（切换表情、动作）；
          // 标签以统一的写法留在后面的文字里，与它所修饰的话一起合成
          sentenceBuffer.value += buffer.value.slice(0, tagStart)
          flushSentences(emit, false)
          emit('emotion', tag)
          sentenceBuffer.value += `[${tag}]`

          buffer.value = buffer.value.slice(tagStart + match[0].length)
          match = buffer.value.match(EMOTION_TAG_REGEX)
        }

        if (data === END_OF_REPLY) {
          // 回复结束：输出剩余的所有文本并结束本次回复
          sentenceBuffer.value += buffer.value
          buffer.value = ''
          flushSentences(emit, true)
          emit('end')
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
    queue.enqueue(END_OF_REPLY)
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
