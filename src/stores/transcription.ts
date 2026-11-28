import type { Provider } from '@/stores/providers'
import { createElevenLabs } from '@ai-sdk/elevenlabs'
import { createOpenAI } from '@ai-sdk/openai'
import { experimental_transcribe as transcribeAudio } from 'ai'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useProvidersStore } from '@/stores/providers'
import { createDashScopeTranscriptionModel } from '@/utils/dashscope'
import { createFishAudioTranscriptionModel } from '@/utils/fish-audio'
import { addHook } from '@/utils/hooks'
import { recordUsage } from '@/stores/usage'
import { wavDurationSeconds } from '@/utils/usage-tracking'

// 识别一句话的超时时间：请求一直没有返回时放弃这一句，免得后面的话都被卡住
const TRANSCRIBE_TIMEOUT = 30_000
// 转录音频文件中切出的一段（约一分钟）的超时时间
const CLIP_TIMEOUT = 90_000

/** 一段录音的转录结果；segments 的时间相对于这段录音的开头（秒） */
export interface ClipTranscript {
  provider: string
  text: string
  segments: { text: string, start: number, end: number }[]
}

// 根据 provider 配置的协议类型，创建对应的 AI SDK 语音识别模型实例
function resolveTranscriptionModel(provider: Provider) {
  const { apiKey, baseUrl, protocol } = provider
  const modelId = provider.selectedModelId

  switch (protocol) {
    case 'openai':
      // OpenAI 兼容的 /audio/transcriptions 接口，SiliconFlow、Groq、本地部署的 whisper 服务等也可以使用
      return createOpenAI({ apiKey, baseURL: baseUrl }).transcription(modelId || 'whisper-1')
    case 'elevenlabs':
      return createElevenLabs({ apiKey }).transcription(modelId || 'scribe_v1')
    case 'dashscope':
      // 千问的语音识别与 OpenAI 的 /audio/transcriptions 不兼容，使用百炼原生接口
      return createDashScopeTranscriptionModel(provider)
    case 'fish-audio':
      // Fish Audio 的语音识别以 multipart 表单上传录音，与 OpenAI 不兼容
      return createFishAudioTranscriptionModel(provider)
    default:
      throw new Error(`协议 ${protocol} 暂不支持语音识别`)
  }
}

// Deepgram 不指定语言时按英语识别，打开自动检测
const PROVIDER_OPTIONS = {
  deepgram: { detectLanguage: true, smartFormat: true },
}

export const useTranscriptionStore = defineStore('transcription', () => {
  const providersStore = useProvidersStore()

  // 正在识别的句数（可能同时识别好几句）
  const pending = ref(0)
  const isTranscribing = computed(() => pending.value > 0)
  // 最近一次识别失败的原因，识别成功后清空
  const error = ref('')

  // 语音识别完成/出错时的钩子函数，用于进行相应处理
  const onFinishHooks = ref<((text: string) => Promise<void>)[]>([])
  const onErrorHooks = ref<((error: unknown) => Promise<void>)[]>([])

  function fail(err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
    onErrorHooks.value.forEach((hook) => hook(err))
  }

  // 把一句话的录音（WAV 等音频文件）识别为文字；失败或者没有识别出文字时返回 undefined，并通过 hooks 通知调用方
  async function transcribe(audio: Uint8Array) {
    const provider = providersStore.getCurrentASRProvider()
    if (!provider) {
      fail(new Error('未配置可用的语音识别 Provider'))
      return
    }

    pending.value++
    try {
      const model = resolveTranscriptionModel(provider)
      const { text, durationInSeconds } = await transcribeAudio({
        model,
        audio,
        providerOptions: PROVIDER_OPTIONS,
        abortSignal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT),
      })
      // 用量：语音识别一般按音频时长计费
      recordUsage(
        { providerId: provider.id, providerName: provider.name, modelId: model.modelId || '默认模型', kind: 'asr' },
        { seconds: wavDurationSeconds(audio) ?? durationInSeconds ?? 0 },
      )
      const result = text.trim()
      error.value = ''
      onFinishHooks.value.forEach((hook) => hook(result))
      return result || undefined
    }
    catch (err) {
      fail(err)
    }
    finally {
      pending.value--
    }
  }

  /**
   * 转录一段录音（如「音频理解」技能切出的一段，WAV），返回文字与服务商给出的分句时间（没有时为空数组）。
   * 与麦克风的语音输入不同：不触发完成 / 出错的钩子，也不算作「正在识别」，出错时直接抛出
   */
  async function transcribeClip(audio: Uint8Array, abortSignal?: AbortSignal): Promise<ClipTranscript> {
    const provider = providersStore.getCurrentASRProvider()
    if (!provider) throw new Error('还没有配置语音识别：请先在 设置 → Provider 中添加语音识别服务，并设为当前使用')
    const model = resolveTranscriptionModel(provider)
    const timeout = AbortSignal.timeout(CLIP_TIMEOUT)
    const { text, segments, durationInSeconds } = await transcribeAudio({
      model,
      audio,
      providerOptions: PROVIDER_OPTIONS,
      abortSignal: abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout,
    })
    recordUsage(
      { providerId: provider.id, providerName: provider.name, modelId: model.modelId || '默认模型', kind: 'asr' },
      { seconds: wavDurationSeconds(audio) ?? durationInSeconds ?? 0 },
    )
    return {
      provider: provider.name,
      text: text.trim(),
      segments: segments.map((segment) => ({ text: segment.text.trim(), start: segment.startSecond, end: segment.endSecond })),
    }
  }

  // 添加语音识别完成/出错时的钩子函数，返回取消注册的函数（组件卸载时应调用）
  function onFinish(hook: (text: string) => Promise<void>) {
    return addHook(onFinishHooks, hook)
  }

  function onError(hook: (error: unknown) => Promise<void>) {
    return addHook(onErrorHooks, hook)
  }

  return {
    isTranscribing,
    error,
    transcribe,
    transcribeClip,
    onFinish,
    onError,
  }
})
