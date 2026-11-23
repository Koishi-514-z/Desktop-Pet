import type { StoredImage } from '@/utils/images'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import { runAgent } from '@/agent'
import { findLatestImageIds, imageMarkers, imageSkill, parseImageIds } from '@/agent/skills/image'

// 用内存中的图片代替 IndexedDB
const images = new Map<string, StoredImage>([
  ['img_a', { id: 'img_a', dataUrl: 'data:image/png;base64,AAAA', mediaType: 'image/png', width: 10, height: 10, createdAt: 0 }],
  ['img_b', { id: 'img_b', dataUrl: 'data:image/jpeg;base64,BBBB', mediaType: 'image/jpeg', width: 10, height: 10, createdAt: 0 }],
])

vi.mock('@/utils/images', () => ({
  loadImage: async (id: string) => images.get(id),
}))

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

/** 取第 n 次调用中用户消息里的图片部分 */
function imagePartsOf(model: MockLanguageModelV3, n: number) {
  const prompt = model.doGenerateCalls[n]!.prompt
  return prompt.flatMap((message) =>
    message.role === 'user' ? message.content.filter((part) => part.type === 'file') : [],
  )
}

const user = (content: string) => ({ role: 'user' as const, content })

describe('图片标记', () => {
  it('生成并解析图片标记', () => {
    const markers = imageMarkers(['img_a', 'img_b'])
    expect(parseImageIds(`看看这两张\n\n${markers}`)).toEqual(['img_a', 'img_b'])
    expect(parseImageIds('没有图片')).toEqual([])
  })

  it('找到最近一条带图片的用户消息', () => {
    const messages = [
      user(`第一张\n\n${imageMarkers(['img_a'])}`),
      { role: 'assistant' as const, content: '好的' },
      user(`第二张\n\n${imageMarkers(['img_b'])}`),
      user('再详细说说'),
    ]
    expect(findLatestImageIds(messages)).toEqual(['img_b'])
  })
})

describe('直接调用图片工具', () => {
  it('使用视觉模型而不是对话模型，并把图片发给它', async () => {
    const chatModel = scriptedModel()
    const visionModel = scriptedModel(text('一只猫坐在键盘上'))

    const res = await runAgent({
      model: chatModel,
      visionModel,
      messages: [user(`这是什么\n\n${imageMarkers(['img_a'])}`)],
      skills: [imageSkill],
      directCall: { skillId: 'image', toolName: 'describe_image', input: { imageIds: ['img_a'] } },
    })

    expect(chatModel.doGenerateCalls).toHaveLength(0)
    expect(visionModel.doGenerateCalls).toHaveLength(1)
    expect(imagePartsOf(visionModel, 0)).toMatchObject([{ type: 'file', mediaType: 'image/png' }])
    expect(res?.displays).toEqual([{ title: '图片解读', content: '一只猫坐在键盘上', format: 'text' }])
  })

  it('没有配置视觉模型时使用对话模型', async () => {
    const model = scriptedModel(text('Error: ENOENT'))
    const res = await runAgent({
      model,
      messages: [user(imageMarkers(['img_b']))],
      skills: [imageSkill],
      directCall: { skillId: 'image', toolName: 'extract_image_text', input: {} },
    })

    expect(imagePartsOf(model, 0)).toMatchObject([{ type: 'file', mediaType: 'image/jpeg' }])
    expect(res?.displays[0]).toMatchObject({ title: '文字提取', content: 'Error: ENOENT' })
  })

  it('模型不支持图片时给出更换模型的提示', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error('unknown variant `image_url`')
      },
    })
    const res = await runAgent({
      model,
      messages: [user(imageMarkers(['img_a']))],
      skills: [imageSkill],
      directCall: { skillId: 'image', toolName: 'analyze_error', input: {} },
    })

    expect(res?.toolCalls[0]?.error).toContain('image_url')
    expect(res?.toolCalls[0]?.error).toContain('支持视觉的模型')
  })

  it('没有图片或图片已被删除时记录错误', async () => {
    const run = (messages: { role: 'user', content: string }[], input: unknown) => runAgent({
      model: scriptedModel(),
      messages,
      skills: [imageSkill],
      directCall: { skillId: 'image', toolName: 'describe_image', input },
    })

    expect((await run([user('这是什么')], {}))?.toolCalls[0]?.error).toContain('没有可处理的图片')
    expect((await run([user('看看')], { imageIds: ['img_gone'] }))?.toolCalls[0]?.error).toContain('找不到图片')
  })
})

describe('通过对话使用图片技能', () => {
  it('追问时省略 imageIds，工具使用最近发送的图片', async () => {
    const chatModel = scriptedModel(
      text('{"skills": ["image"], "reason": "翻译图片文字"}'),
      call('translate_image', { targetLanguage: '日语' }),
      text('已翻译成日语'),
    )
    const visionModel = scriptedModel(text('エラーが発生しました'))

    const res = await runAgent({
      model: chatModel,
      visionModel,
      messages: [
        user(`帮我看看这个报错\n\n${imageMarkers(['img_a', 'img_b'])}`),
        { role: 'assistant', content: '是文件找不到的错误' },
        user('把图里的文字翻译成日语'),
      ],
      skills: [imageSkill],
    })

    expect(imagePartsOf(visionModel, 0)).toHaveLength(2)
    expect(JSON.stringify(visionModel.doGenerateCalls[0]!.prompt)).toContain('翻译成日语')
    expect(res?.displays).toEqual([{ title: '图片翻译 · 日语', content: 'エラーが発生しました', format: 'text' }])
  })
})
