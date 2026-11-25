import type { GeneratedAudioFile } from 'ai'
import type { Provider } from '@/stores/providers'
import { createDeepgram } from '@ai-sdk/deepgram'
import { createElevenLabs } from '@ai-sdk/elevenlabs'
import { createHume } from '@ai-sdk/hume'
import { createLMNT } from '@ai-sdk/lmnt'
import { createOpenAI } from '@ai-sdk/openai'
import { experimental_generateSpeech as generateSpeech } from 'ai'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useProvidersStore } from '@/stores/providers'
import { createDashScopeSpeechModel } from '@/utils/dashscope'
import { addHook } from '@/utils/hooks'

// 根据 provider 配置的协议类型，创建对应的 AI SDK 语音合成模型实例
function resolveSpeechModel(provider: Provider) {
  const { apiKey, baseUrl, protocol } = provider
  const modelId = provider.selectedModelId

  switch (protocol) {
    case 'openai':
      return createOpenAI({ apiKey, baseURL: baseUrl }).speech(modelId)
    case 'elevenlabs':
      return createElevenLabs({ apiKey }).speech(modelId)
    case 'lmnt':
      return createLMNT({ apiKey }).speech(modelId)
    case 'hume':
      return createHume({ apiKey }).speech()
    case 'deepgram':
      return createDeepgram({ apiKey }).speech(modelId)
    case 'index-tts':
      // server 提供 OpenAI 兼容的 /audio/speech 接口；本地服务可不设 apiKey
      return createOpenAI({ apiKey, baseURL: baseUrl, name: 'index-tts' }).speech(modelId || 'index-tts')
    case 'dashscope':
      // 千问的语音合成与 OpenAI 不兼容，使用百炼原生接口
      return createDashScopeSpeechModel(provider)
    default:
      throw new Error(`协议 ${protocol} 暂不支持语音合成`)
  }
}

export const useSpeechStore = defineStore('speech', () => {
  const providersStore = useProvidersStore()

  // 是否正在合成语音
  const isGenerating = ref(false)

  // 语音合成完成/出错时的钩子函数，用于进行相应处理
  const onFinishHooks = ref<((audio: GeneratedAudioFile) => Promise<void>)[]>([])
  const onErrorHooks = ref<((error: unknown) => Promise<void>)[]>([])

  // 将文本转换为语音，完成后返回生成的音频文件，并通过 hooks 回调通知调用方
  async function speak(text: string) {
    const provider = providersStore.getCurrentTTSProvider()
    if (!provider) {
      onErrorHooks.value.forEach(hook => hook(new Error('未配置可用的 TTS Provider')))
      return
    }

    isGenerating.value = true
    try {
      const model = resolveSpeechModel(provider)
      const { audio } = await generateSpeech({
        model,
        text,
        voice: provider.selectedVoiceId || undefined,
        // index-tts 本地服务只输出 wav
        ...(provider.protocol === 'index-tts' ? { outputFormat: 'wav' } : {}),
      })

      onFinishHooks.value.forEach(hook => hook(audio))
      return audio
    }
    catch (error) {
      onErrorHooks.value.forEach(hook => hook(error))
    }
    finally {
      isGenerating.value = false
    }
  }

  // 添加语音合成完成/出错时的钩子函数，返回取消注册的函数（组件卸载时应调用）
  function onFinish(hook: (audio: GeneratedAudioFile) => Promise<void>) {
    return addHook(onFinishHooks, hook)
  }

  function onError(hook: (error: unknown) => Promise<void>) {
    return addHook(onErrorHooks, hook)
  }

  return {
    isGenerating,
    speak,
    onFinish,
    onError,
  }
})
