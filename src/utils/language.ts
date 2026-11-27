import type { LanguageModel } from 'ai'
import { generateText } from 'ai'

/**
 * 桌宠回复使用的语言：显示在屏幕上的（对话框与字幕），以及念出来的（语音合成）。
 * 设置值为下面的预置语言之一，或用户输入的任意语言名称；为空表示不指定
 */
export const LANGUAGE_OPTIONS = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'yue', label: '粤语' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'es', label: 'Español' },
  { value: 'ru', label: 'Русский' },
] as const

// 提示词中使用的语言名称：说清楚是哪一种，避免模型理解错（如繁体还是简体、粤语口语还是书面语）
const PROMPT_NAMES: Record<string, string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁体中文（台湾用语）',
  'yue': '粤语（广东话口语，用繁体字书写）',
  'en': '英语',
  'ja': '日语',
  'ko': '韩语',
  'fr': '法语',
  'de': '德语',
  'es': '西班牙语',
  'ru': '俄语',
}

export function isPresetLanguage(value: string): boolean {
  return LANGUAGE_OPTIONS.some((option) => option.value === value)
}

/** 界面上显示的语言名称；用户输入的语言原样显示 */
export function languageLabel(value: string): string {
  return LANGUAGE_OPTIONS.find((option) => option.value === value)?.label ?? value
}

/** 提示词中使用的语言名称；用户输入的语言原样使用 */
export function languagePromptName(value: string): string {
  return PROMPT_NAMES[value] ?? value
}

/** 要求桌宠用指定语言回复的提示词，附加在系统提示词末尾；不指定语言时返回空字符串 */
export function buildReplyLanguagePrompt(language: string): string {
  if (!language) return ''
  const name = languagePromptName(language)
  return [
    `【回复语言】无论用户用什么语言说话、之前的对话用的是什么语言，你说的话都只用${name}。`,
    '情绪标签（如 [happy]、[short pause]）照原样写英文，不要翻译。',
    `用户明确要求的内容（如把一段话翻译成别的语言、教一句外语）可以使用要求的语言，但你自己说的话仍然用${name}。`,
  ].join('')
}

/** 念出来的语言与显示的语言不同时，需要先把台词翻译成要念的语言再合成语音 */
export function needsSpeechTranslation(displayLanguage: string, speechLanguage: string): boolean {
  return !!speechLanguage && speechLanguage !== displayLanguage
}

// 前文只用来保持译文的连贯（称呼、用词一致），不必很长
const CONTEXT_LENGTH = 600

export interface TranslateForSpeechOptions {
  model: LanguageModel
  text: string
  language: string
  // 这一轮回复中、这句话之前的内容（原文），用于保持译文连贯
  context?: string
  abortSignal?: AbortSignal
}

/** 把桌宠要念的一段台词翻译成指定语言，交给语音合成朗读 */
export async function translateForSpeech({ model, text, language, context, abortSignal }: TranslateForSpeechOptions): Promise<string> {
  if (!text.trim()) return text
  const name = languagePromptName(language)
  const system = [
    `你是桌宠的配音译者。用户发来的是桌宠接下来要念出来的一段台词，请把它翻译成${name}，交给语音合成朗读。`,
    '- 只输出译文本身，不要解释，不要加引号，不要注音或罗马音',
    '- 保持原来的语气、口吻和称呼，读起来要像自然的口语',
    `- 已经是${name}的部分原样保留；专有名词、代码、网址等不必翻译`,
    '- 方括号括起来的英文标签（如 [laughs]、[short pause]）是给语音合成的语气提示，照原样保留在译文中对应的位置，不要翻译或删掉',
  ].join('\n')
  const trimmedContext = context?.trim().slice(-CONTEXT_LENGTH)
  const prompt = trimmedContext
    ? `【前文，已经念过了，只供参考，不要翻译】\n${trimmedContext}\n\n【要翻译的台词】\n${text}`
    : text

  const { text: translated } = await generateText({ model, system, prompt, abortSignal })
  return translated.trim() || text
}
