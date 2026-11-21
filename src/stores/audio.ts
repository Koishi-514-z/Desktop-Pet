import type { GeneratedAudioFile } from 'ai'
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useAudioStore = defineStore('audio', () => {
  // 当前正在播放的 <audio> 元素
  let currentAudio: HTMLAudioElement | null = null
  // 当前音频对应的 Blob URL，播放结束后需要释放
  let currentObjectUrl: string | null = null

  // 用于实时分析播放音量的 AudioContext / AnalyserNode
  let audioContext: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let volumeFrameId: number | null = null

  // 是否正在播放音频
  const isPlaying = ref(false)

  // 是否使用自定义的播放器
  const useCustomPlayer = ref(false)

  // 自定义的播放函数
  const customPlayHooks = ref<((audio: GeneratedAudioFile) => Promise<void>)[]>([])

  // 播放结束/出错时的钩子函数
  const onEndHooks = ref<((audio: GeneratedAudioFile) => Promise<void>)[]>([])
  const onErrorHooks = ref<((error: unknown) => Promise<void>)[]>([])

  // 当前播放音频的实时音量（0~1，基于波形 RMS 计算）
  const volume = ref(0)

  // 基于 AnalyserNode 实时采集 <audio> 元素的音量，写入 volume
  function startVolumeMeter(element: HTMLAudioElement) {
    audioContext ??= new AudioContext()

    const source = audioContext.createMediaElementSource(element)
    analyser = audioContext.createAnalyser()
    analyser.fftSize = 512

    // 接入 analyser 的同时仍需连到 destination，否则元素将无声
    source.connect(analyser)
    analyser.connect(audioContext.destination)

    const data = new Uint8Array(analyser.fftSize)
    const tick = () => {
      if (!analyser) return

      analyser.getByteTimeDomainData(data)

      let sumSquares = 0
      for (const sample of data) {
        const normalized = (sample - 128) / 128
        sumSquares += normalized * normalized
      }
      volume.value = Math.sqrt(sumSquares / data.length)

      volumeFrameId = requestAnimationFrame(tick)
    }
    tick()
  }

  // 停止音量采集
  function stopVolumeMeter() {
    if (volumeFrameId !== null) {
      cancelAnimationFrame(volumeFrameId)
      volumeFrameId = null
    }
    analyser = null
    volume.value = 0
  }

  // 释放当前音频占用的资源
  function cleanup() {
    stopVolumeMeter()
    if (currentAudio) {
      currentAudio.pause()
      currentAudio = null
    }
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl)
      currentObjectUrl = null
    }
  }

  // 播放生成的音频文件
  async function play(audio: GeneratedAudioFile) {
    // 停止上一段正在播放的音频
    stop()

    // 若已注册自定义播放函数，则用其替代默认的 <audio> 播放逻辑
    if (useCustomPlayer.value && customPlayHooks.value.length > 0) {
      isPlaying.value = true
      try {
        for (const hook of customPlayHooks.value) {
          await hook(audio)
        }
        onEndHooks.value.forEach(hook => hook(audio))
      }
      catch (error) {
        onErrorHooks.value.forEach(hook => hook(error))
      }
      finally {
        isPlaying.value = false
      }
      return
    }

    // 将音频数据转换为 Blob URL，交由 <audio> 元素播放
    const blob = new Blob([new Uint8Array(audio.uint8Array)], { type: audio.mediaType })
    const url = URL.createObjectURL(blob)
    currentObjectUrl = url

    const element = new Audio(url)
    currentAudio = element

    element.addEventListener('ended', () => {
      isPlaying.value = false
      cleanup()
      onEndHooks.value.forEach(hook => hook(audio))
    })

    element.addEventListener('error', () => {
      isPlaying.value = false
      cleanup()
      onErrorHooks.value.forEach(hook => hook(new Error('音频播放失败')))
    })

    try {
      isPlaying.value = true
      await element.play()
      startVolumeMeter(element)
    }
    catch (error) {
      isPlaying.value = false
      cleanup()
      onErrorHooks.value.forEach(hook => hook(error))
    }
  }

  // 停止当前播放
  function stop() {
    isPlaying.value = false
    cleanup()
  }

  // 添加播放结束/出错时的钩子函数
  function onEnd(hook: (audio: GeneratedAudioFile) => Promise<void>) {
    onEndHooks.value.push(hook)
  }
  
  function onError(hook: (error: unknown) => Promise<void>) {
    onErrorHooks.value.push(hook)
  }

  // 注册自定义播放函数，注册后自动启用自定义播放器
  function addCustomPlayer(hook: (audio: GeneratedAudioFile) => Promise<void>) {
    customPlayHooks.value.push(hook)
    useCustomPlayer.value = true
  }

  return {
    isPlaying,
    useCustomPlayer,
    volume,
    play,
    stop,
    onEnd,
    onError,
    addCustomPlayer,
  }
})
