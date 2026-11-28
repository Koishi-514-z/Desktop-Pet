import type { GeneratedAudioFile } from 'ai'
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { useSceneStore } from './scene'
import { addHook } from '@/utils/hooks'

export const useAudioStore = defineStore('audio', () => {
  const sceneStore = useSceneStore()

  // 当前正在播放的 <audio> 元素
  let currentAudio: HTMLAudioElement | null = null
  // 当前音频对应的 Blob URL，播放结束后需要释放
  let currentObjectUrl: string | null = null
  // 结束当前这段播放（resolve 对应 play() 返回的 Promise）
  let resolveCurrent: (() => void) | null = null

  // 用于实时分析播放音量的 AudioContext / AnalyserNode
  let audioContext: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let mediaSource: MediaElementAudioSourceNode | null = null
  // 控制播放音量的增益节点（位于 analyser 之后，因此口型同步不受音量影响）
  let gainNode: GainNode | null = null
  let volumeFrameId: number | null = null

  // 是否正在播放音频
  const isPlaying = ref(false)

  // 当前这一轮回复是否还有语音没播完：从第一句话送去合成，到最后一句播完为止（句子之间等待合成的空档也算在内）。
  // 由 Stage 中的语音流水线维护；字幕据此等语音全部播完后才开始隐藏的倒计时
  const speechPending = ref(false)

  // 正在重听的收藏（见 stores/favorites.ts）：播放期间字幕显示这句话，而不是对话中的消息
  const replay = ref<{ text: string, speaker: string } | null>(null)

  // 是否使用自定义的播放器
  const useCustomPlayer = ref(false)

  // 自定义的播放函数
  const customPlayHooks = ref<((audio: GeneratedAudioFile) => Promise<void>)[]>([])

  // 播放结束/出错时的钩子函数
  const onEndHooks = ref<((audio: GeneratedAudioFile) => Promise<void>)[]>([])
  const onErrorHooks = ref<((error: unknown) => Promise<void>)[]>([])

  // 当前播放音频的实时音量（0~1，基于波形 RMS 计算）
  const volume = ref(0)

  // 将设置中的音量限制在 0~1 之间
  function getPlaybackVolume() {
    const value = Number(sceneStore.playbackVolume)
    return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 1
  }

  // 音量设置变化时实时作用于正在播放的音频
  watch(() => sceneStore.playbackVolume, () => {
    if (gainNode) gainNode.gain.value = getPlaybackVolume()
  })

  // 基于 AnalyserNode 实时采集 <audio> 元素的音量，写入 volume，
  // 并经 GainNode 按设置的音量输出
  function startVolumeMeter(element: HTMLAudioElement) {
    audioContext ??= new AudioContext()
    if (audioContext.state === 'suspended') audioContext.resume()

    if (!gainNode) {
      gainNode = audioContext.createGain()
      gainNode.connect(audioContext.destination)
    }
    gainNode.gain.value = getPlaybackVolume()

    mediaSource = audioContext.createMediaElementSource(element)
    analyser = audioContext.createAnalyser()
    analyser.fftSize = 512

    // source -> analyser -> gain -> destination
    mediaSource.connect(analyser)
    analyser.connect(gainNode)

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
    mediaSource?.disconnect()
    mediaSource = null
    analyser?.disconnect()
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

    // 返回的 Promise 在本段音频播放结束 / 出错 / 被 stop() 时才 resolve，
    // 以便调用方 await 后再播放下一段
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (callback?: () => void) => {
        if (settled) return
        settled = true
        if (resolveCurrent === finish) resolveCurrent = null
        isPlaying.value = false
        cleanup()
        callback?.()
        resolve()
      }
      resolveCurrent = finish

      element.addEventListener('ended', () => {
        finish(() => onEndHooks.value.forEach(hook => hook(audio)))
      })

      element.addEventListener('error', () => {
        finish(() => onErrorHooks.value.forEach(hook => hook(new Error('音频播放失败'))))
      })

      isPlaying.value = true
      // 在播放前接入音频图，确保从第一帧起就按设置的音量输出
      startVolumeMeter(element)
      element.play()
        .catch((error) => {
          finish(() => onErrorHooks.value.forEach(hook => hook(error)))
        })
    })
  }

  // 停止当前播放，并让正在等待的 play() 立即返回
  function stop() {
    if (resolveCurrent) {
      resolveCurrent()
    }
    else {
      isPlaying.value = false
      cleanup()
    }
  }

  // 添加播放结束/出错时的钩子函数，返回取消注册的函数（组件卸载时应调用）
  function onEnd(hook: (audio: GeneratedAudioFile) => Promise<void>) {
    return addHook(onEndHooks, hook)
  }

  function onError(hook: (error: unknown) => Promise<void>) {
    return addHook(onErrorHooks, hook)
  }

  // 注册自定义播放函数，注册后自动启用自定义播放器
  function addCustomPlayer(hook: (audio: GeneratedAudioFile) => Promise<void>) {
    customPlayHooks.value.push(hook)
    useCustomPlayer.value = true
  }

  return {
    isPlaying,
    speechPending,
    replay,
    useCustomPlayer,
    volume,
    play,
    stop,
    onEnd,
    onError,
    addCustomPlayer,
  }
})
