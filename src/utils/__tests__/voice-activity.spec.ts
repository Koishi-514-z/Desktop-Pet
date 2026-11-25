import { describe, expect, it } from 'vitest'
import { encodeWav, frameRms, VOICE_FRAME_SAMPLES, VOICE_SAMPLE_RATE, VoiceActivityDetector } from '@/utils/voice-activity'

const FRAME_MS = VOICE_FRAME_SAMPLES / VOICE_SAMPLE_RATE * 1000

/** 若干毫秒的正弦波（模拟说话），振幅为 amplitude；amplitude 为 0 时是完全的安静 */
function sound(ms: number, amplitude: number): Float32Array[] {
  const frames: Float32Array[] = []
  for (let i = 0; i < ms / FRAME_MS; i++) {
    frames.push(Float32Array.from({ length: VOICE_FRAME_SAMPLES }, (_, n) => amplitude * Math.sin(2 * Math.PI * 220 * (i * VOICE_FRAME_SAMPLES + n) / VOICE_SAMPLE_RATE)))
  }
  return frames
}

/** 依次送入各段声音，返回检测出的每句话的时长（毫秒）以及它在第几帧结束 */
function run(detector: VoiceActivityDetector, ...parts: Float32Array[][]) {
  const utterances: { ms: number, frame: number, samples: Float32Array }[] = []
  parts.flat().forEach((frame, index) => {
    const samples = detector.push(frame)
    if (samples) utterances.push({ ms: samples.length / VOICE_SAMPLE_RATE * 1000, frame: index, samples })
  })
  return utterances
}

describe('语音检测', () => {
  it('音量：一帧声音的均方根', () => {
    expect(frameRms(new Float32Array(320))).toBe(0)
    expect(frameRms(new Float32Array(320).fill(0.5))).toBeCloseTo(0.5)
  })

  it('说完一句话：保留开口前约 0.3 秒与说完后约 0.2 秒，安静 0.9 秒后输出', () => {
    const detector = new VoiceActivityDetector()
    // 0.5 秒校准，再安静 0.5 秒后说 1 秒
    const result = run(detector, sound(500, 0), sound(500, 0), sound(1000, 0.2), sound(1500, 0))
    expect(result).toHaveLength(1)
    // 说完后安静 0.9 秒（第 45 帧）时输出
    expect(result[0]!.frame).toBe(25 + 25 + 50 + 45 - 1)
    // 开口前约 0.24 秒（保留的约 0.3 秒中包括判断开始说话的 60 ms）+ 说话 1 秒 + 说完后 0.2 秒
    expect(result[0]!.ms).toBeGreaterThanOrEqual(1440)
    expect(result[0]!.ms).toBeLessThanOrEqual(1460)
    // 开头是开口前的安静部分（没有吞掉第一个字），结尾是保留的一小段安静
    expect(frameRms(result[0]!.samples.subarray(0, 1600))).toBeLessThan(0.01)
    expect(frameRms(result[0]!.samples.subarray(-1600))).toBeLessThan(0.01)
    expect(detector.speaking).toBe(false)
  })

  it('太短的声音（如敲一下桌子）当作杂音丢掉', () => {
    const detector = new VoiceActivityDetector()
    const states: boolean[] = []
    for (const frame of [...sound(500, 0), ...sound(100, 0.3), ...sound(1200, 0)]) {
      expect(detector.push(frame)).toBeNull()
      states.push(detector.speaking)
    }
    // 中间确实判断为开始说话了，只是说完后发现太短
    expect(states).toContain(true)
    expect(detector.speaking).toBe(false)
  })

  it('打开时就有的持续噪声不算说话，比噪声大得多的声音才算', () => {
    const detector = new VoiceActivityDetector()
    expect(run(detector, sound(500, 0.03), sound(3000, 0.03))).toEqual([])
    expect(detector.speaking).toBe(false)
    expect(run(detector, sound(600, 0.3), sound(1000, 0.03))).toHaveLength(1)
  })

  it('一句话太长时强制切开，接着当作同一段话继续检测', () => {
    const detector = new VoiceActivityDetector({ maxSpeechMs: 2000 })
    const result = run(detector, sound(500, 0), sound(4500, 0.2), sound(1200, 0))
    // 2 秒 + 2 秒 + 剩下的 0.5 秒与说完后保留的 0.2 秒
    expect(result.map((item) => Math.round(item.ms / 100))).toEqual([20, 20, 7])
    expect(detector.speaking).toBe(false)
  })

  it('重置后丢掉正在检测的这句话；重新校准后按新的环境噪声判断', () => {
    const detector = new VoiceActivityDetector()
    run(detector, sound(500, 0), sound(600, 0.2))
    expect(detector.speaking).toBe(true)
    detector.reset()
    expect(detector.speaking).toBe(false)
    expect(run(detector, sound(1200, 0))).toEqual([])

    // 换到更吵的环境：重新校准后，原来算说话的音量不再算
    detector.recalibrate()
    expect(run(detector, sound(500, 0.05), sound(600, 0.05), sound(1200, 0.05))).toEqual([])
  })
})

describe('WAV 编码', () => {
  it('16 位 PCM 单声道，采样值限制在 -1 ~ 1', () => {
    const wav = encodeWav(Float32Array.from([0, 1, -1, 0.5, 2]))
    const view = new DataView(wav.buffer)
    const text = (offset: number, length: number) => String.fromCharCode(...wav.subarray(offset, offset + length))
    expect(text(0, 4)).toBe('RIFF')
    expect(text(8, 4)).toBe('WAVE')
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(VOICE_SAMPLE_RATE)
    expect(view.getUint16(34, true)).toBe(16)
    expect(text(36, 4)).toBe('data')
    expect(view.getUint32(40, true)).toBe(10)
    expect(wav.length).toBe(44 + 10)
    expect([0, 1, 2, 3, 4].map((i) => view.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 16383, 32767])
  })
})
