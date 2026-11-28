import type { ClipTranscript } from '@/stores/transcription'
import type { TranscriptSegment } from '@/utils/audios'
import { encodeWav } from '@/utils/voice-activity'

/**
 * 转录音频文件（「音频理解」技能）：
 * 1. 解码成 16 kHz 单声道（用这个采样率的 AudioContext 解码，浏览器会顺便重采样）；
 * 2. 切成约一分钟的片段，在停顿处下刀，不把一句话切成两半；
 * 3. 每段编码成 WAV，交给当前的语音识别服务并发转录，再按时间拼起来。
 * 服务商给出了分句时间时用它，否则一段算一句。
 */

export const SAMPLE_RATE = 16000
/** 最长能转录多长的音频：解码后的数据都在内存里（一小时约 230 MB） */
export const MAX_DURATION_SECONDS = 2 * 3600
/** 同时转录的片段数 */
const CONCURRENCY = 3

export interface ChunkPlan {
  /** 目标长度（秒） */
  target?: number
  /** 在 [target - slack, target + slack] 秒之间找最安静的地方切开 */
  slack?: number
  /** 计算音量的窗口（秒） */
  window?: number
}

/** 把一段录音切成几段，返回每段的 [起点, 终点)（采样点）。最后剩下不足一段时并到上一段（不超过最长长度时） */
export function planChunks(samples: Float32Array, sampleRate: number, options: ChunkPlan = {}): [number, number][] {
  const { target = 60, slack = 15, window = 0.05 } = options
  const total = samples.length
  const targetSamples = Math.round(target * sampleRate)
  const slackSamples = Math.round(slack * sampleRate)
  const windowSamples = Math.max(1, Math.round(window * sampleRate))
  const chunks: [number, number][] = []

  let start = 0
  while (total - start > targetSamples + slackSamples) {
    // 在可以切的范围内，找音量最小的窗口；连续几个窗口一样安静时（如一段静音），从这一段的中间切开
    let runStart = start + targetSamples
    let runEnd = runStart
    let bestEnergy = Infinity
    const from = start + targetSamples - slackSamples
    const to = start + targetSamples + slackSamples - windowSamples
    for (let offset = from; offset <= to; offset += windowSamples) {
      let energy = 0
      for (let i = offset; i < offset + windowSamples; i++) energy += samples[i]! * samples[i]!
      if (energy < bestEnergy) {
        bestEnergy = energy
        runStart = offset
        runEnd = offset
      }
      else if (energy === bestEnergy && offset === runEnd + windowSamples) {
        runEnd = offset
      }
    }
    const cut = Math.round((runStart + runEnd + windowSamples) / 2)
    chunks.push([start, cut])
    start = cut
  }
  if (start < total) chunks.push([start, total])
  return chunks
}

/** 解码音频文件为 16 kHz 单声道 */
export async function decodeAudio(data: Blob): Promise<Float32Array> {
  const context = new AudioContext({ sampleRate: SAMPLE_RATE })
  try {
    const buffer = await context.decodeAudioData(await data.arrayBuffer())
    const mono = new Float32Array(buffer.length)
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const samples = buffer.getChannelData(channel)
      for (let i = 0; i < samples.length; i++) mono[i]! += samples[i]! / buffer.numberOfChannels
    }
    return mono
  }
  catch (error) {
    throw new Error(`无法解码这个音频文件，可能是不支持的格式（${error instanceof Error ? error.message : String(error)}）`)
  }
  finally {
    void context.close()
  }
}

export interface TranscribeOptions {
  /** 转录一段 WAV，返回文字与相对这一段开头的分句时间 */
  transcribe: (wav: Uint8Array, signal?: AbortSignal) => Promise<ClipTranscript>
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
}

/** 切段、并发转录，返回整段音频的分句（时间为相对整段开头的秒数） */
export async function transcribeSamples(samples: Float32Array, options: TranscribeOptions): Promise<{ provider: string, segments: TranscriptSegment[] }> {
  const { transcribe, signal, onProgress } = options
  const chunks = planChunks(samples, SAMPLE_RATE)
  const results: TranscriptSegment[][] = Array.from({ length: chunks.length }, () => [])
  let provider = ''
  let done = 0
  let next = 0
  onProgress?.(0, chunks.length)

  const worker = async () => {
    while (next < chunks.length) {
      const index = next++
      const [from, to] = chunks[index]!
      const offset = from / SAMPLE_RATE
      const result = await transcribe(encodeWav(samples.subarray(from, to), SAMPLE_RATE), signal)
      provider = result.provider
      results[index] = result.segments.length
        ? result.segments.filter((segment) => segment.text).map((segment) => ({ start: offset + segment.start, end: offset + segment.end, text: segment.text }))
        : result.text ? [{ start: offset, end: to / SAMPLE_RATE, text: result.text }] : []
      onProgress?.(++done, chunks.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker))
  return { provider, segments: results.flat() }
}

/** 时间戳，如 00:01:23 */
export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
}

/** 带时间戳的转录稿，每句一行 */
export function formatTranscript(segments: TranscriptSegment[]): string {
  return segments.map((segment) => `[${formatTimestamp(segment.start)}] ${segment.text}`).join('\n')
}

/** 截取一段 WAV 交给能听音频的模型（只取开头 maxSeconds 秒） */
export function clipWav(samples: Float32Array, maxSeconds: number): { wav: Uint8Array, seconds: number, truncated: boolean } {
  const length = Math.min(samples.length, Math.round(maxSeconds * SAMPLE_RATE))
  return { wav: encodeWav(samples.subarray(0, length), SAMPLE_RATE), seconds: length / SAMPLE_RATE, truncated: length < samples.length }
}
