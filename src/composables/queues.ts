import { createQueue, createParallelSequencedQueue, type HandlerContext } from "@/utils/queue"
import type { GeneratedAudioFile } from "ai"
import { ref } from "vue"
import { encodeWav, VOICE_SAMPLE_RATE, VoiceActivityDetector, type VoiceActivityOptions } from "@/utils/voice-activity"

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
  // context：这一轮回复中这句话之前的内容，念的语言与显示的不同、需要翻译时用来保持译文连贯
  | { type: 'speech', text: string, context?: string }
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
export const MIN_SENTENCE_LENGTH = 100

/** 句子的长度：不算标点、符号与空白 */
export function sentenceLength(text: string): number {
  return text.replace(/[\s\p{P}\p{S}]/gu, '').length
}

// 文本处理队列：将流式接收到的文本按 <Emotion> 标记切分，
// 再按句末标点将文本切分为完整语句（太短的与下一句合并），依次 emit 'text'（语句）与 'emotion'（标记中的情绪名称）事件。
// 检测到终止标记后，输出剩余的所有文本（无论是否构成完整语句、是否够长）并 emit 'end'；
export function useTextProcessingQueue() {
  // 尚未处理的文本缓冲区，可能包含不完整的标记
  const buffer = ref('')

  // 已确定不属于标记、但尚未输出的文本缓冲区：还没凑成完整语句，或者是等着与下一句合并的短句
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
