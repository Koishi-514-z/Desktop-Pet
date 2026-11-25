import { defineStore } from 'pinia'
import { ref } from 'vue'
import { addHook } from '@/utils/hooks'
import { frameRms, VOICE_FRAME_SAMPLES, VOICE_SAMPLE_RATE } from '@/utils/voice-activity'

// AudioWorklet：把麦克风的声音按固定长度（20 ms）一帧一帧发给主线程
const CAPTURE_WORKLET = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.frame = new Float32Array(${VOICE_FRAME_SAMPLES})
    this.length = 0
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.frame[this.length++] = channel[i]
        if (this.length === this.frame.length) {
          this.port.postMessage(this.frame)
          this.length = 0
        }
      }
    }
    return true
  }
}
registerProcessor('pcm-capture', PcmCapture)
`

// 界面上显示的音量：说话的音量（RMS）通常在 0.05 ~ 0.3 之间，放大后便于看出变化
const LEVEL_GAIN = 4

function describeError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return '没有麦克风权限，请在弹出的提示中允许使用麦克风'
  if (name === 'NotFoundError') return '没有找到麦克风'
  if (name === 'NotReadableError') return '麦克风被其他程序占用，或者无法打开'
  return `打开麦克风失败：${error instanceof Error ? error.message : String(error)}`
}

// 麦克风：打开后把声音按帧交给注册的钩子（由 Stage 中的语音输入管线检测出一句句话）
export const useMicrophoneStore = defineStore('microphone', () => {
  // 麦克风是否已打开、是否正在打开
  const isListening = ref(false)
  const isStarting = ref(false)
  // 当前的输入音量（0~1），用于界面显示
  const level = ref(0)
  // 是否检测到用户正在说话（由 Stage 中的语音输入管线维护）
  const userSpeaking = ref(false)
  // 打开麦克风失败或麦克风断开时的说明
  const error = ref('')

  const frameHooks = ref<((frame: Float32Array) => void)[]>([])

  let stream: MediaStream | null = null
  let context: AudioContext | null = null
  let workletUrl: string | null = null

  function release() {
    stream?.getTracks().forEach((track) => track.stop())
    stream = null
    void context?.close()
    context = null
    level.value = 0
    userSpeaking.value = false
  }

  async function start() {
    if (isListening.value || isStarting.value) return
    isStarting.value = true
    error.value = ''
    // 在点击的同一时刻创建，避免因为自动播放策略处于暂停状态
    context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE })
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      workletUrl ??= URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }))
      await context.audioWorklet.addModule(workletUrl)
      if (context.state === 'suspended') await context.resume()

      const source = context.createMediaStreamSource(stream)
      const capture = new AudioWorkletNode(context, 'pcm-capture')
      capture.port.onmessage = (event: MessageEvent<Float32Array>) => {
        const frame = event.data
        level.value = Math.min(1, frameRms(frame) * LEVEL_GAIN)
        frameHooks.value.forEach((hook) => hook(frame))
      }
      // 接到一个静音的输出上，保证音频图一直在运行
      const mute = context.createGain()
      mute.gain.value = 0
      source.connect(capture)
      capture.connect(mute)
      mute.connect(context.destination)

      // 麦克风被拔出或被系统关闭
      stream.getAudioTracks()[0]?.addEventListener('ended', () => {
        stop()
        error.value = '麦克风已断开'
      })
      isListening.value = true
    }
    catch (err) {
      error.value = describeError(err)
      release()
    }
    finally {
      isStarting.value = false
    }
  }

  function stop() {
    release()
    isListening.value = false
  }

  function toggle() {
    if (isListening.value) stop()
    else void start()
  }

  // 接收麦克风的每一帧声音（16 kHz 单声道，20 ms），返回取消注册的函数（组件卸载时应调用）
  function onFrame(hook: (frame: Float32Array) => void) {
    return addHook(frameHooks, hook)
  }

  return {
    isListening,
    isStarting,
    level,
    userSpeaking,
    error,
    start,
    stop,
    toggle,
    onFrame,
  }
})
