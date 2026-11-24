import type { AgentEvent, Skill } from '@/agent/types'
import { simulateReadableStream, tool } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { runAgent } from '@/agent'

// 模型调用的参数与结果的类型（@ai-sdk/provider 不是项目的直接依赖，从模拟模型上取）
type CallOptions = Parameters<MockLanguageModelV3['doGenerate']>[0]
type GenerateResult = Awaited<ReturnType<MockLanguageModelV3['doGenerate']>>
type Content = GenerateResult['content'][number]
type StreamPart = Awaited<ReturnType<MockLanguageModelV3['doStream']>>['stream'] extends ReadableStream<infer T> ? T : never
type FinishReason = GenerateResult['finishReason']['unified']
// 预设的回复：partial 表示输出超过长度上限时没写完的工具调用；Error 表示接口出错
type Scripted = (GenerateResult & { partial?: { toolName: string, input: string } }) | Error

// 两个简化的技能：先读出图片中的文字，才知道要写文档
const writeDocument = vi.fn<(input: { title: string }) => Promise<{ saved: string }>>(async ({ title }) => ({ saved: `${title}.docx` }))

const pictureSkill: Skill = {
  id: 'picture',
  name: '图片理解',
  description: '读出用户发来的图片中的内容',
  instructions: '用 read_picture 读出图片中的文字',
  tools: {
    read_picture: tool({
      description: '读出图片中的文字',
      inputSchema: z.object({}),
      execute: async () => ({ text: '请帮我写一份 Word 文档，标题是「周报」' }),
    }),
  },
}

const documentSkill: Skill = {
  id: 'document',
  name: 'Office 文档',
  description: '新建或修改 Word 文档',
  instructions: '用 write_document 写 Word 文档',
  tools: {
    write_document: tool({
      description: '写一份 Word 文档',
      inputSchema: z.object({ title: z.string() }),
      execute: writeDocument,
    }),
  },
}

const unusedSkill: Skill = {
  id: 'weather',
  name: '天气',
  description: '查询天气',
  instructions: '用 get_weather 查询天气',
  tools: { get_weather: tool({ description: '查询天气', inputSchema: z.object({}), execute: async () => ({}) }) },
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

function reply(content: Content[], finish: FinishReason): GenerateResult {
  return { content, finishReason: { unified: finish, raw: finish }, usage, warnings: [] }
}

const text = (value: string) => reply([{ type: 'text', text: value }], 'stop')
const call = (toolName: string, input: unknown) => reply([{ type: 'tool-call', toolCallId: `call-${toolName}`, toolName, input: JSON.stringify(input) }], 'tool-calls')
// 输出超过长度上限：工具调用只写了一部分。OpenAI 兼容的接口会丢弃没写完的工具调用
const truncated = (toolName: string, input: string): Scripted => ({ ...reply([], 'length'), partial: { toolName, input } })

/** 把预设的回复转换成流式输出（工具执行阶段使用流式输出） */
function toStream(result: Exclude<Scripted, Error>): ReadableStream<StreamPart> {
  const parts: StreamPart[] = [{ type: 'stream-start', warnings: [] }]
  for (const item of result.content) {
    if (item.type === 'text') {
      parts.push({ type: 'text-start', id: 'text' }, { type: 'text-delta', id: 'text', delta: item.text }, { type: 'text-end', id: 'text' })
    }
    else if (item.type === 'tool-call') {
      parts.push(
        { type: 'tool-input-start', id: item.toolCallId, toolName: item.toolName },
        { type: 'tool-input-delta', id: item.toolCallId, delta: item.input },
        { type: 'tool-input-end', id: item.toolCallId },
        item,
      )
    }
  }
  if (result.partial) {
    parts.push(
      { type: 'tool-input-start', id: 'partial', toolName: result.partial.toolName },
      { type: 'tool-input-delta', id: 'partial', delta: result.partial.input },
    )
  }
  parts.push({ type: 'finish', finishReason: result.finishReason, usage: result.usage })
  return simulateReadableStream({ chunks: parts })
}

/** 依次返回预设的回复，并记录每次调用时的系统提示与可用的工具 */
function scriptedModel(replies: Scripted[]) {
  const calls: CallOptions[] = []
  const next = (options: CallOptions) => {
    calls.push(options)
    const result = replies.shift()
    if (!result) throw new Error('没有更多预设的回复')
    if (result instanceof Error) throw result
    return result
  }
  const model = new MockLanguageModelV3({
    // 意图识别一次生成；工具执行流式生成
    doGenerate: async (options) => next(options),
    doStream: async (options) => ({ stream: toStream(next(options)) }),
  })
  return { model, calls }
}

const systemOf = (options: CallOptions) => options.prompt.find((message) => message.role === 'system')?.content ?? ''
const toolsOf = (options: CallOptions) => (options.tools ?? []).map((item) => item.name).sort()

describe('执行中加载技能', () => {
  it('识别图片后发现还需要别的技能时，加载后继续完成', async () => {
    const { model, calls } = scriptedModel([
      // 意图识别：只看到了图片，只选了图片理解
      text('{"skills": ["picture"], "reason": "用户发了一张图片"}'),
      call('read_picture', {}),
      call('load_skills', { skillIds: ['document'], reason: '图片里要求写 Word 文档' }),
      call('write_document', { title: '周报' }),
      text('已按图片中的要求写好了周报.docx'),
    ])
    const events: AgentEvent[] = []

    const result = await runAgent({
      model,
      messages: [{ role: 'user', content: '【附图：image-1】' }],
      skills: [pictureSkill, documentSkill, unusedSkill],
      onEvent: (event) => events.push(event),
    })

    // 执行的第一步：只有图片理解的工具与 load_skills；其他技能在系统提示中列出，但没有加载
    const [, first, , third] = calls
    expect(toolsOf(first!)).toEqual(['load_skills', 'read_picture'])
    expect(systemOf(first!)).toContain('- document（Office 文档）：新建或修改 Word 文档')
    expect(systemOf(first!)).not.toContain('用 write_document 写 Word 文档')
    // 加载之后：可以使用文档技能的工具，它的使用说明加入了系统提示
    expect(toolsOf(third!)).toEqual(['load_skills', 'read_picture', 'write_document'])
    expect(systemOf(third!)).toContain('## Office 文档（document）\n用 write_document 写 Word 文档')

    expect(writeDocument).toHaveBeenCalledWith({ title: '周报' }, expect.anything())
    expect(result?.skills.map((skill) => skill.id)).toEqual(['picture', 'document'])
    // 加载技能只是中间步骤，不作为工具调用的结果交给角色扮演阶段
    expect(result?.toolCalls.map((item) => item.toolName)).toEqual(['read_picture', 'write_document'])
    expect(result?.summary).toBe('已按图片中的要求写好了周报.docx')
    // 界面上的进度会更新为加载后的技能
    expect(events.filter((event) => event.type === 'routed').map((event) => event.type === 'routed' && event.skills.map((skill) => skill.name))).toEqual([
      ['图片理解'],
      ['图片理解', 'Office 文档'],
    ])
  })

  it('加载不存在的技能时把错误告诉模型，模型可以改正', async () => {
    const { model, calls } = scriptedModel([
      call('load_skills', { skillIds: ['word'], reason: '要写文档' }),
      call('load_skills', { skillIds: ['document'], reason: '要写文档' }),
      text('好了'),
    ])
    const { executeSkills } = await import('@/agent/executor')
    const result = await executeSkills({ model, messages: [{ role: 'user', content: '写周报' }], skills: [pictureSkill, documentSkill] }, [pictureSkill])

    // 第一次加载失败的原因（以及可以加载的技能）作为工具结果交给了模型
    const toolResult = JSON.stringify(calls[1]!.prompt)
    expect(toolResult).toContain('没有这些技能：word')
    expect(toolResult).toContain('可以加载的技能：document')
    expect(result.skills.map((skill) => skill.id)).toEqual(['picture', 'document'])
  })

  it('所有技能都已加载时不提供 load_skills', async () => {
    const { model, calls } = scriptedModel([text('好了')])
    const { executeSkills } = await import('@/agent/executor')
    await executeSkills({ model, messages: [{ role: 'user', content: '你好' }], skills: [pictureSkill] }, [pictureSkill])
    expect(toolsOf(calls[0]!)).toEqual(['read_picture'])
    expect(systemOf(calls[0]!)).not.toContain('其他可用技能')
  })
})

// 与真实的图片理解技能同一个 id：只有用户发来的图片会触发「按图片中的要求继续完成」
const imageSkill: Skill = {
  id: 'image',
  name: '图片理解',
  description: '理解用户发送的图片',
  instructions: '用 look_image 查看图片',
  tools: {
    look_image: tool({
      description: '查看图片',
      inputSchema: z.object({}),
      execute: async () => ({ display: { title: '图片解读', content: '图片中是一段文字：请帮我写一份 Word 文档，标题是「周报」' } }),
    }),
  },
}

describe('按图片中的要求继续完成', () => {
  function run(replies: Scripted[], events: AgentEvent[] = []) {
    const { model, calls } = scriptedModel(replies)
    const result = runAgent({
      model,
      messages: [{ role: 'user', content: '（发送了 1 张图片）\n\n【附图：image-1】' }],
      skills: [imageSkill, documentSkill, unusedSkill],
      onEvent: (event) => events.push(event),
    })
    return { result, calls }
  }

  it('模型读出图片后没有自己加载技能时，带着图片内容再识别一次意图，继续完成', async () => {
    writeDocument.mockClear()
    const events: AgentEvent[] = []
    const { result, calls } = run([
      text('{"skills": ["image"], "reason": "用户发了一张图片"}'),
      call('look_image', {}),
      // 真实的模型常常读完图片就结束，不会想到图中的文字是要它完成的任务
      text('图片中是一段要求写周报的文字'),
      text('{"skills": ["document"], "reason": "图片是用户写给你的要求"}'),
      call('write_document', { title: '周报' }),
      text('已经写好了周报.docx'),
    ], events)
    const agent = await result

    // 第二次意图识别看得到图片的内容，候选技能中不包括图片理解
    const imageRouter = calls[3]!
    expect(systemOf(imageRouter)).toContain('图片中的内容已经读出来了')
    expect(systemOf(imageRouter)).not.toContain('- image（')
    expect(JSON.stringify(imageRouter.prompt)).toContain('请帮我写一份 Word 文档，标题是「周报」')
    // 继续执行时：图片内容在系统提示中，文档技能与图片理解技能都已加载
    expect(systemOf(calls[4]!)).toContain('# 用户写在图片中的要求')
    expect(toolsOf(calls[4]!)).toEqual(['load_skills', 'look_image', 'write_document'])

    expect(writeDocument).toHaveBeenCalledWith({ title: '周报' }, expect.anything())
    expect(agent?.skills.map((skill) => skill.id)).toEqual(['image', 'document'])
    expect(agent?.toolCalls.map((item) => item.toolName)).toEqual(['look_image', 'write_document'])
    expect(agent?.displays.map((item) => item.title)).toEqual(['图片解读'])
    expect(agent?.summary).toBe('图片中是一段要求写周报的文字\n\n已经写好了周报.docx')
    expect(events.filter((event) => event.type === 'routed').map((event) => event.type === 'routed' && event.skills.map((skill) => skill.id))).toEqual([
      ['image'],
      ['image', 'document'],
    ])
  })

  it('只是想看懂图片时，到此为止', async () => {
    const { result, calls } = run([
      text('{"skills": ["image"], "reason": "用户发了一张图片"}'),
      call('look_image', {}),
      text('图片中是一段文字'),
      text('{"skills": [], "reason": "用户只是想看懂图片"}'),
    ])
    const agent = await result
    expect(calls).toHaveLength(4)
    expect(agent?.skills.map((skill) => skill.id)).toEqual(['image'])
    expect(agent?.toolCalls.map((item) => item.toolName)).toEqual(['look_image'])
  })

  it('模型已经自己加载了需要的技能时，不再识别', async () => {
    writeDocument.mockClear()
    const { result, calls } = run([
      text('{"skills": ["image"], "reason": "用户发了一张图片"}'),
      call('look_image', {}),
      call('load_skills', { skillIds: ['document'], reason: '图片里要求写 Word 文档' }),
      call('write_document', { title: '周报' }),
      text('已经写好了周报.docx'),
    ])
    const agent = await result
    expect(calls).toHaveLength(5)
    expect(writeDocument).toHaveBeenCalledTimes(1)
    expect(agent?.skills.map((skill) => skill.id)).toEqual(['image', 'document'])
  })
})

describe('流式执行', () => {
  const messages = [{ role: 'user' as const, content: '写一份很长的周报' }]

  it('显示编写较长参数的进度', async () => {
    const statuses: string[] = []
    const { model } = scriptedModel([call('write_document', { title: '周'.repeat(300) }), text('好了')])
    const { executeSkills } = await import('@/agent/executor')
    await executeSkills({ model, messages, skills: [documentSkill], setStatus: (status) => statuses.push(status) }, [documentSkill])
    expect(statuses).toContainEqual(expect.stringMatching(/^正在使用技能：Office 文档（正在编写，已写 3\d\d 字）$/))
    // 工具执行完，开始下一步时恢复为技能名称
    expect(statuses.at(-1)).toBe('正在使用技能：Office 文档')
  })

  it('输出超过长度上限、工具调用没写完时，提醒精简后重试', async () => {
    writeDocument.mockClear()
    const { model, calls } = scriptedModel([
      call('load_skills', { skillIds: ['document'], reason: '要写文档' }),
      truncated('write_document', '{"title": "很长很长'),
      call('write_document', { title: '周报' }),
      text('好了'),
    ])
    const { executeSkills } = await import('@/agent/executor')
    const result = await executeSkills({ model, messages, skills: [pictureSkill, documentSkill] }, [pictureSkill])

    expect(systemOf(calls[1]!)).not.toContain('输出被截断')
    // 重试时带着之前的步骤（已经加载的技能仍然可用），并提醒精简
    const retry = calls[2]!
    expect(systemOf(retry)).toContain('# 注意：上一次的输出被截断了')
    expect(toolsOf(retry)).toEqual(['read_picture', 'write_document'])
    expect(JSON.stringify(retry.prompt)).toContain('load_skills')
    expect(writeDocument).toHaveBeenCalledWith({ title: '周报' }, expect.anything())
    expect(result.error).toBeUndefined()
    expect(result.summary).toBe('好了')
  })

  it('重试后仍然超过长度上限时说明原因', async () => {
    const { model, calls } = scriptedModel([
      truncated('write_document', '{"title": "很长'),
      truncated('write_document', '{"title": "还是很长'),
    ])
    const { executeSkills } = await import('@/agent/executor')
    const result = await executeSkills({ model, messages, skills: [documentSkill] }, [documentSkill])
    expect(calls).toHaveLength(2)
    expect(result.error).toContain('长度上限')
  })

  it('接口出错时报告真正的错误', async () => {
    const { model } = scriptedModel([new Error('401 Unauthorized')])
    const { executeSkills } = await import('@/agent/executor')
    const result = await executeSkills({ model, messages, skills: [documentSkill] }, [documentSkill])
    expect(result.error).toBe('401 Unauthorized')
  })
})
