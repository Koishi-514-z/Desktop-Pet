import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { buildReplyLanguagePrompt, languageLabel, needsSpeechTranslation, translateForSpeech } from '@/utils/language'

type CallOptions = Parameters<MockLanguageModelV3['doGenerate']>[0]

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

function translator(output: string) {
  const calls: CallOptions[] = []
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      calls.push(options)
      return { content: [{ type: 'text', text: output }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }
    },
  })
  return { model, calls }
}

const textOf = (options: CallOptions, role: 'system' | 'user') =>
  options.prompt
    .filter((message) => message.role === role)
    .map((message) => (typeof message.content === 'string' ? message.content : message.content.map((part) => ('text' in part ? part.text : '')).join('')))
    .join('\n')

describe('回复语言', () => {
  it('指定显示语言时要求模型只用这种语言回复，情绪标签保持原样；不指定时不附加', () => {
    expect(buildReplyLanguagePrompt('')).toBe('')
    const prompt = buildReplyLanguagePrompt('ja')
    expect(prompt).toContain('只用日语')
    expect(prompt).toContain('[happy]')
    // 自己输入的语言原样使用
    expect(buildReplyLanguagePrompt('Italiano')).toContain('只用Italiano')
    expect(languageLabel('zh-TW')).toBe('繁體中文')
    expect(languageLabel('Italiano')).toBe('Italiano')
  })

  it('念的语言没有指定、或者和显示的一样时不用翻译', () => {
    expect(needsSpeechTranslation('', '')).toBe(false)
    expect(needsSpeechTranslation('zh-CN', '')).toBe(false)
    expect(needsSpeechTranslation('ja', 'ja')).toBe(false)
    expect(needsSpeechTranslation('zh-CN', 'ja')).toBe(true)
    // 显示的语言不指定时不知道回复是什么语言，交给翻译判断（已经是要念的语言就原样保留）
    expect(needsSpeechTranslation('', 'en')).toBe(true)
  })

  it('翻译要念的台词：带上前文保持连贯，只取模型输出的译文', async () => {
    const { model, calls } = translator('  今日はいい天気だね！\n')
    const text = await translateForSpeech({ model, text: '今天天气真好！', language: 'ja', context: '早上好呀。' })

    expect(text).toBe('今日はいい天気だね！')
    expect(textOf(calls[0]!, 'system')).toContain('翻译成日语')
    // 情绪标签要原样留在译文里，交给支持标签的语音合成
    expect(textOf(calls[0]!, 'system')).toContain('[short pause]')
    const user = textOf(calls[0]!, 'user')
    expect(user).toContain('早上好呀。')
    expect(user).toContain('今天天气真好！')
  })

  it('模型什么都没返回时念原文；空白的台词不请求', async () => {
    const { model, calls } = translator('')
    await expect(translateForSpeech({ model, text: '你好', language: 'en' })).resolves.toBe('你好')
    await expect(translateForSpeech({ model, text: '  ', language: 'en' })).resolves.toBe('  ')
    expect(calls).toHaveLength(1)
  })
})
