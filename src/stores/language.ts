import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed } from 'vue'
import { useAgentStore } from '@/stores/agent'
import { useProvidersStore } from '@/stores/providers'
import { buildReplyLanguagePrompt, needsSpeechTranslation, translateForSpeech } from '@/utils/language'
import { resolveLanguageModel } from '@/utils/llm'

/**
 * 桌宠回复的语言。用户自己输入的内容不受影响。
 * - 显示语言：对话框与字幕中桌宠的回复使用的语言，通过系统提示词要求模型用这种语言回复；为空时不指定（通常跟着用户的语言）
 * - 念的语言：语音合成使用的语言，与显示语言不同时，每句话合成语音前先翻译；为空时与显示的内容相同
 */
export const useLanguageStore = defineStore('language', () => {
  const providersStore = useProvidersStore()
  const agentStore = useAgentStore()

  const displayLanguage = useLocalStorage('settings/language/display', '')
  const speechLanguage = useLocalStorage('settings/language/speech', '')

  /** 附加在系统提示词末尾的回复语言要求；不指定语言时为空字符串 */
  const replyLanguagePrompt = computed(() => buildReplyLanguagePrompt(displayLanguage.value.trim()))

  /** 念之前是否需要翻译 */
  const translatesSpeech = computed(() => needsSpeechTranslation(displayLanguage.value.trim(), speechLanguage.value.trim()))

  /**
   * 把桌宠要念的一句话转换成念的语言：不需要翻译时原样返回。
   * 翻译用意图识别的小模型（快、便宜），没有设置时用当前的对话模型；翻译失败时念原文，总比不出声好
   */
  async function toSpeechText(text: string, options: { context?: string, abortSignal?: AbortSignal } = {}): Promise<string> {
    if (!translatesSpeech.value) return text

    const provider = providersStore.getCurrentLLMProvider()
    const model = agentStore.resolveRouterModel() ?? (provider ? resolveLanguageModel(provider) : undefined)
    if (!model) return text

    try {
      return await translateForSpeech({ model, text, language: speechLanguage.value.trim(), ...options })
    }
    catch (error) {
      if (options.abortSignal?.aborted) throw error
      console.warn('[language] 翻译要念的台词失败，改念原文：', error)
      return text
    }
  }

  function resetToDefault() {
    displayLanguage.value = ''
    speechLanguage.value = ''
  }

  return {
    displayLanguage,
    speechLanguage,
    replyLanguagePrompt,
    translatesSpeech,
    toSpeechText,
    resetToDefault,
  }
})
