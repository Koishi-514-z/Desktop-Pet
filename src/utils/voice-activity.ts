/**
 * 语音输入的基础工具：从麦克风的声音中检测出一句一句的话，并把一句话编码为 WAV 交给语音识别接口。
 *
 * 检测按音量（RMS）判断：超过阈值一小段时间算开始说话，安静一段时间算说完一句。
 * 阈值随环境噪声自动调整（噪声底的若干倍，并且不低于一个下限）；开始说话前的一小段声音也会保留，
 * 避免吞掉第一个字。说话部分太短的当作杂音丢掉，一句话太长时强制切开。
 */

/** 送去识别的声音：16 kHz 单声道 */
export const VOICE_SAMPLE_RATE = 16_000
/** 麦克风每次送来的一帧：20 ms */
export const VOICE_FRAME_SAMPLES = 320

export interface VoiceActivityOptions {
  sampleRate?: number
  /** 音量（RMS）至少要超过多少才算在说话 */
  minThreshold?: number
  /** 音量超过噪声底的多少倍才算在说话 */
  noiseRatio?: number
  /** 音量连续超过阈值多久才算开始说话（毫秒） */
  startMs?: number
  /** 安静多久算说完一句（毫秒） */
  silenceMs?: number
  /** 开始说话前保留多久的声音（毫秒） */
  preRollMs?: number
  /** 说完后保留多久的安静部分（毫秒） */
  trailingMs?: number
  /** 说话的部分至少要有多长，否则当作杂音丢掉（毫秒） */
  minSpeechMs?: number
  /** 一句话最长多久，超过时强制切开（毫秒） */
  maxSpeechMs?: number
  /** 刚开始的这段时间只测量环境噪声、不检测说话（毫秒）：打开麦克风时就有的持续噪声不会被当成说话 */
  calibrationMs?: number
}

const DEFAULT_OPTIONS: Required<VoiceActivityOptions> = {
  calibrationMs: 500,
  sampleRate: VOICE_SAMPLE_RATE,
  minThreshold: 0.012,
  noiseRatio: 3,
  startMs: 60,
  silenceMs: 900,
  preRollMs: 300,
  trailingMs: 200,
  minSpeechMs: 250,
  maxSpeechMs: 30_000,
}

// 说话过程中，音量降到阈值的这个比例以下才算安静（避免在阈值附近来回跳）
const HYSTERESIS = 0.8

/** 一帧声音的音量（均方根） */
export function frameRms(frame: Float32Array): number {
  if (frame.length === 0) return 0
  let sum = 0
  for (const sample of frame) sum += sample * sample
  return Math.sqrt(sum / frame.length)
}

function concat(frames: Float32Array[]): Float32Array {
  const result = new Float32Array(frames.reduce((total, frame) => total + frame.length, 0))
  let offset = 0
  for (const frame of frames) {
    result.set(frame, offset)
    offset += frame.length
  }
  return result
}

export class VoiceActivityDetector {
  private readonly options: Required<VoiceActivityOptions>
  // 噪声底：没在说话时的平均音量，下降快、上升慢
  private noiseFloor: number
  // 已经用来测量环境噪声的时长与帧数
  private calibratedMs = 0
  private calibrationFrames = 0
  // 没在说话时，最近一小段声音（开始说话时并入这一句）
  private preRoll: Float32Array[] = []
  private preRollMs = 0
  // 音量连续超过阈值的时长
  private loudMs = 0

  private active = false
  private frames: Float32Array[] = []
  private totalMs = 0
  private voicedMs = 0
  private silentMs = 0

  constructor(options: VoiceActivityOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
    this.noiseFloor = this.options.minThreshold / this.options.noiseRatio
  }

  /** 是否正在说一句话 */
  get speaking(): boolean {
    return this.active
  }

  /** 当前的音量阈值 */
  get threshold(): number {
    return Math.max(this.options.minThreshold, this.noiseFloor * this.options.noiseRatio)
  }

  /** 送入一帧声音，返回这一帧之后说完的一句话（没有时为 null） */
  push(frame: Float32Array): Float32Array | null {
    const frameMs = frame.length / this.options.sampleRate * 1000
    const rms = frameRms(frame)

    if (this.calibratedMs < this.options.calibrationMs) {
      this.noiseFloor = (this.noiseFloor * this.calibrationFrames + rms) / (this.calibrationFrames + 1)
      this.calibrationFrames++
      this.calibratedMs += frameMs
      return null
    }

    const threshold = this.threshold

    if (!this.active) {
      this.noiseFloor = rms < this.noiseFloor ? this.noiseFloor * 0.7 + rms * 0.3 : this.noiseFloor * 0.995 + rms * 0.005
      this.preRoll.push(frame)
      this.preRollMs += frameMs
      while (this.preRoll.length > 1 && this.preRollMs - this.preRoll[0]!.length / this.options.sampleRate * 1000 >= this.options.preRollMs) {
        this.preRollMs -= this.preRoll.shift()!.length / this.options.sampleRate * 1000
      }

      this.loudMs = rms > threshold ? this.loudMs + frameMs : 0
      if (this.loudMs >= this.options.startMs) {
        this.active = true
        this.frames = this.preRoll
        this.totalMs = this.preRollMs
        this.voicedMs = this.loudMs
        this.silentMs = 0
        this.preRoll = []
        this.preRollMs = 0
        this.loudMs = 0
      }
      return null
    }

    this.frames.push(frame)
    this.totalMs += frameMs
    if (rms > threshold * HYSTERESIS) {
      this.voicedMs += frameMs
      this.silentMs = 0
    }
    else {
      this.silentMs += frameMs
    }

    if (this.silentMs >= this.options.silenceMs) return this.finish(frameMs, false)
    if (this.totalMs >= this.options.maxSpeechMs) return this.finish(frameMs, true)
    return null
  }

  /** 重新测量环境噪声（如重新打开麦克风时），并丢掉正在检测的这句话 */
  recalibrate() {
    this.reset()
    this.noiseFloor = this.options.minThreshold / this.options.noiseRatio
    this.calibratedMs = 0
    this.calibrationFrames = 0
  }

  /** 丢掉正在检测的这句话（如桌宠开始说话时）；测得的噪声底保留 */
  reset() {
    this.active = false
    this.frames = []
    this.totalMs = 0
    this.voicedMs = 0
    this.silentMs = 0
    this.preRoll = []
    this.preRollMs = 0
    this.loudMs = 0
  }

  // 说完一句：去掉末尾大部分的安静部分；说话部分太短时当作杂音丢掉。
  // 太长被强制切开时，接着当作在说话，下一句从这里继续
  private finish(frameMs: number, forced: boolean): Float32Array | null {
    const dropFrames = Math.max(0, Math.floor((this.silentMs - this.options.trailingMs) / frameMs))
    const frames = this.frames.slice(0, this.frames.length - dropFrames)
    const longEnough = this.voicedMs >= this.options.minSpeechMs

    if (forced) {
      this.frames = []
      this.totalMs = 0
      this.voicedMs = 0
      this.silentMs = 0
    }
    else {
      this.reset()
    }
    return longEnough && frames.length > 0 ? concat(frames) : null
  }
}

function writeString(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}

/** 编码为 16 位 PCM 单声道的 WAV 文件 */
export function encodeWav(samples: Float32Array, sampleRate = VOICE_SAMPLE_RATE): Uint8Array {
  const dataSize = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // 单声道
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]!))
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true)
  }
  return new Uint8Array(buffer)
}
