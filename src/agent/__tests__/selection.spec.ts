import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { runAgent } from '@/agent'
import { extractDisplay } from '@/agent/context'
import { buildAgentContextPrompt } from '@/agent/prompts'
import { attachQuote, findLatestQuote, isMostlyChinese, MAX_TEXT_LENGTH, selectionSkill } from '@/agent/skills/selection'

type GenerateResult = Awaited<ReturnType<MockLanguageModelV3['doGenerate']>>
type Content = GenerateResult['content'][number]

function result(content: Content[], finish: 'stop' | 'tool-calls' = 'stop'): GenerateResult {
  return {
    content,
    finishReason: { unified: finish, raw: undefined },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  }
}

const text = (value: string) => result([{ type: 'text', text: value }])
const call = (toolName: string, input: unknown) =>
  result([{ type: 'tool-call', toolCallId: 'call-1', toolName, input: JSON.stringify(input) }], 'tool-calls')

function scriptedModel(...results: GenerateResult[]) {
  let index = 0
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const next = results[index++]
      if (!next) throw new Error('模型调用次数超出预期')
      return next
    },
  })
}

/** 取第 n 次模型调用的完整提示词文本 */
function promptOf(model: MockLanguageModelV3, n: number): string {
  return JSON.stringify(model.doGenerateCalls[n]!.prompt)
}

const user = (content: string) => ({ role: 'user' as const, content })

describe('划词辅助函数', () => {
  it('判断文本是否以中文为主', () => {
    expect(isMostlyChinese('今天天气不错')).toBe(true)
    expect(isMostlyChinese('The quick brown fox')).toBe(false)
    expect(isMostlyChinese('用 useState 管理 state')).toBe(true)
    expect(isMostlyChinese('   ')).toBe(false)
    expect(isMostlyChinese('今日はいい天気ですね')).toBe(false)
    expect(isMostlyChinese('Call the API with a timeout of 30 seconds 然后重试')).toBe(false)
  })

  it('从对话中找到最近一次划词内容', () => {
    const messages = [
      user(attachQuote('翻译', 'first')),
      { role: 'assistant' as const, content: '好的' },
      user(attachQuote('解释', 'second\nline')),
      user('再翻译成日语'),
    ]
    expect(findLatestQuote(messages)).toBe('second\nline')
    expect(findLatestQuote([user('你好')])).toBeUndefined()
  })

  it('解析工具返回值中的结果卡片', () => {
    expect(extractDisplay({ display: { title: '翻译', content: 'hi' } })).toEqual({ title: '翻译', content: 'hi', format: 'text' })
    expect(extractDisplay({ display: { title: 'x' } })).toBeNull()
    expect(extractDisplay('text')).toBeNull()
  })
})

describe('直接调用划词工具', () => {
  it('跳过意图识别，用技能上下文中的模型完成翻译并生成卡片', async () => {
    const model = scriptedModel(text('Hello, world'))

    const res = await runAgent({
      model,
      messages: [user(attachQuote('帮我翻译', '你好，世界'))],
      skills: [selectionSkill],
      directCall: { skillId: 'selection', toolName: 'translate_text', input: { text: '你好，世界' } },
    })

    // 只有工具内部的一次模型调用
    expect(model.doGenerateCalls).toHaveLength(1)
    expect(promptOf(model, 0)).toContain('翻译成英语')
    expect(promptOf(model, 0)).toContain('你好，世界')
    expect(res?.displays).toEqual([{ title: '翻译 · 英语', content: 'Hello, world', format: 'text' }])
    expect(res?.toolCalls[0]?.error).toBeUndefined()

    const context = buildAgentContextPrompt(res!)
    expect(context).toContain('「翻译 · 英语」的完整内容已经单独展示')
  })

  it('外文默认译成简体中文，可以指定目标语言', async () => {
    const model = scriptedModel(text('你好'), text('こんにちは'))
    const run = (input: unknown) => runAgent({
      model,
      messages: [user('翻译')],
      skills: [selectionSkill],
      directCall: { skillId: 'selection', toolName: 'translate_text', input },
    })

    expect((await run({ text: 'Hello' }))?.displays[0]?.title).toBe('翻译 · 简体中文')
    expect((await run({ text: 'Hello', targetLanguage: '日语' }))?.displays[0]?.title).toBe('翻译 · 日语')
  })

  it('超长文本截断处理并在卡片中注明', async () => {
    const model = scriptedModel(text('总结'))
    const res = await runAgent({
      model,
      messages: [user('总结')],
      skills: [selectionSkill],
      directCall: { skillId: 'selection', toolName: 'summarize_text', input: { text: 'a'.repeat(MAX_TEXT_LENGTH + 100) } },
    })
    expect(res?.displays[0]?.content).toContain(`只处理了前 ${MAX_TEXT_LENGTH} 个字符`)
  })

  it('没有可处理的文字时记录错误而不是抛出', async () => {
    const model = scriptedModel()
    const res = await runAgent({
      model,
      messages: [user('总结一下')],
      skills: [selectionSkill],
      directCall: { skillId: 'selection', toolName: 'summarize_text', input: {} },
    })
    expect(res?.toolCalls[0]?.error).toContain('没有可处理的文字')
    expect(res?.displays).toEqual([])
  })

  it('技能未启用时抛出错误', async () => {
    await expect(runAgent({
      model: scriptedModel(),
      messages: [user('翻译')],
      skills: [],
      directCall: { skillId: 'selection', toolName: 'translate_text', input: { text: 'hi' } },
    })).rejects.toThrow('未启用')
  })
})

describe('通过对话使用划词技能', () => {
  it('追问时省略 text，工具从对话中读取最近一次划词的原文', async () => {
    const model = scriptedModel(
      text('{"skills": ["selection"], "reason": "翻译划词内容"}'),
      call('translate_text', { targetLanguage: '日语' }),
      text('こんにちは世界'),
      text('已翻译成日语'),
    )

    const res = await runAgent({
      model,
      messages: [
        user(attachQuote('帮我翻译', '你好，世界')),
        { role: 'assistant', content: '翻好啦' },
        user('再翻译成日语'),
      ],
      skills: [selectionSkill],
    })

    // 第 3 次调用是工具内部的翻译请求，原文来自之前的划词
    expect(promptOf(model, 2)).toContain('你好，世界')
    expect(promptOf(model, 2)).toContain('翻译成日语')
    expect(res?.displays).toEqual([{ title: '翻译 · 日语', content: 'こんにちは世界', format: 'text' }])
    expect(res?.summary).toBe('已翻译成日语')
  })
})
