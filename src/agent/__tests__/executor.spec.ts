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

const loadedOf = (events: AgentEvent[]) => events.flatMap((event) => (event.type === 'skills-loaded' ? [event.skills.map((skill) => skill.id)] : []))

describe('意图识别与按需加载技能', () => {
  const messages = [{ role: 'user' as const, content: '帮我写一份周报' }]

  it('意图识别只区分闲聊与任务，需要哪些技能由执行模块根据技能目录加载', async () => {
    writeDocument.mockClear()
    const { model, calls } = scriptedModel([
      text('{"task": true, "complex": false, "reason": "要写文档"}'),
      call('load_skills', { skillIds: ['document'], reason: '要写 Word 文档' }),
      call('write_document', { title: '周报' }),
      text('写好了周报.docx'),
    ])
    const events: AgentEvent[] = []
    const result = await runAgent({ model, messages, skills: [pictureSkill, documentSkill, unusedSkill], onEvent: (event) => events.push(event) })

    // 意图识别：只输出是不是任务，不选择技能
    const [router, first, second] = calls
    expect(systemOf(router!)).toContain('{"task": true, "complex": false, "reason": "一句话理由"}')
    expect(toolsOf(router!)).toEqual([])
    // 执行的第一步：还没有加载技能，只有 load_skills；技能目录在系统提示中，但没有使用说明
    expect(toolsOf(first!)).toEqual(['load_skills'])
    expect(systemOf(first!)).toContain('还没有加载任何技能')
    expect(systemOf(first!)).toContain('- document（Office 文档）：新建或修改 Word 文档')
    expect(systemOf(first!)).not.toContain('用 write_document 写 Word 文档')
    // 加载之后：可以使用文档技能的工具，它的使用说明加入了系统提示
    expect(toolsOf(second!)).toEqual(['load_skills', 'write_document'])
    expect(systemOf(second!)).toContain('## Office 文档（document）\n用 write_document 写 Word 文档')

    expect(writeDocument).toHaveBeenCalledWith({ title: '周报' }, expect.anything())
    expect(result?.skills.map((skill) => skill.id)).toEqual(['document'])
    // 加载技能只是中间步骤，不作为工具调用的结果交给角色扮演阶段
    expect(result?.toolCalls.map((item) => item.toolName)).toEqual(['write_document'])
    expect(result?.summary).toBe('写好了周报.docx')
    // 界面上的进度会更新为加载后的技能
    expect(loadedOf(events)).toEqual([['document']])
  })

  it('消息中带有划词内容时预先加载划词助手', async () => {
    const selectionSkill: Skill = {
      id: 'selection',
      name: '划词助手',
      description: '处理划词选中的文字',
      instructions: '用 translate 翻译',
      tools: { translate: tool({ description: '翻译', inputSchema: z.object({}), execute: async () => ({ text: '你好' }) }) },
    }
    const { model, calls } = scriptedModel([text('{"task": true, "reason": "翻译划词内容"}'), call('translate', {}), text('翻译好了')])
    const events: AgentEvent[] = []
    await runAgent({
      model,
      messages: [{ role: 'user', content: '翻译一下\n\n【划词内容】\nhello' }],
      skills: [selectionSkill, documentSkill],
      onEvent: (event) => events.push(event),
    })
    expect(toolsOf(calls[1]!)).toEqual(['load_skills', 'translate'])
    expect(loadedOf(events)).toEqual([['selection']])
  })

  it('意图识别使用单独的小模型，执行仍然使用对话模型', async () => {
    const router = scriptedModel([text('{"task": true, "reason": "要写文档"}')])
    const main = scriptedModel([call('load_skills', { skillIds: ['document'], reason: '写文档' }), call('write_document', { title: '周报' }), text('好了')])
    const result = await runAgent({ model: main.model, routerModel: router.model, messages, skills: [documentSkill] })

    expect(router.calls).toHaveLength(1)
    expect(main.calls).toHaveLength(3)
    expect(toolsOf(main.calls[0]!)).toEqual(['load_skills'])
    expect(result?.summary).toBe('好了')
  })

  it('闲聊时不执行；执行模块判断不需要技能时也按普通对话处理', async () => {
    const chat = scriptedModel([text('{"task": false, "reason": "闲聊"}')])
    expect(await runAgent({ model: chat.model, messages: [{ role: 'user', content: '你好呀' }], skills: [documentSkill] })).toBeNull()
    expect(chat.calls).toHaveLength(1)

    const unneeded = scriptedModel([text('{"task": true, "reason": "拿不准"}'), text('不需要技能')])
    expect(await runAgent({ model: unneeded.model, messages: [{ role: 'user', content: '一加一等于几' }], skills: [documentSkill] })).toBeNull()
    expect(unneeded.calls).toHaveLength(2)
  })

  it('意图识别失败时交给执行模块判断，以免所有任务都被当成闲聊', async () => {
    const router = scriptedModel([new Error('模型不存在')])
    const main = scriptedModel([call('load_skills', { skillIds: ['document'], reason: '写文档' }), call('write_document', { title: '周报' }), text('好了')])
    const events: AgentEvent[] = []
    const result = await runAgent({ model: main.model, routerModel: router.model, messages, skills: [documentSkill], onEvent: (event) => events.push(event) })

    expect(result?.summary).toBe('好了')
    expect(events).toContainEqual({ type: 'routed', decision: { task: true, reason: '意图识别失败，交给执行模块判断' } })
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
    expect(systemOf(calls[0]!)).not.toContain('可以加载的技能')
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

  it('用户发了图片时预先加载图片理解；读出图片后没有自己加载技能时，带着图片内容再判断一次，继续完成', async () => {
    writeDocument.mockClear()
    const events: AgentEvent[] = []
    const { result, calls } = run([
      text('{"task": true, "reason": "用户发了一张图片"}'),
      // 图片理解已经预先加载，第一步就可以查看图片
      call('look_image', {}),
      // 真实的模型常常读完图片就结束，不会想到图中的文字是要它完成的任务
      text('图片中是一段要求写周报的文字'),
      text('{"task": true, "reason": "图片是用户写给你的要求"}'),
      call('load_skills', { skillIds: ['document'], reason: '按图片的要求写 Word 文档' }),
      call('write_document', { title: '周报' }),
      text('已经写好了周报.docx'),
    ], events)
    const agent = await result

    expect(toolsOf(calls[1]!)).toEqual(['load_skills', 'look_image'])
    // 第二次判断看得到图片的内容，技能目录中不包括图片理解
    const imageRouter = calls[3]!
    expect(systemOf(imageRouter)).toContain('图片中的内容已经读出来了')
    expect(systemOf(imageRouter)).not.toContain('- image（')
    expect(JSON.stringify(imageRouter.prompt)).toContain('请帮我写一份 Word 文档，标题是「周报」')
    // 继续执行时：图片内容在系统提示中，图片理解仍然加载着，其余的技能由执行模块加载
    expect(systemOf(calls[4]!)).toContain('# 用户写在图片中的要求')
    expect(toolsOf(calls[4]!)).toEqual(['load_skills', 'look_image'])
    expect(toolsOf(calls[5]!)).toEqual(['load_skills', 'look_image', 'write_document'])

    expect(writeDocument).toHaveBeenCalledWith({ title: '周报' }, expect.anything())
    expect(agent?.skills.map((skill) => skill.id)).toEqual(['image', 'document'])
    expect(agent?.toolCalls.map((item) => item.toolName)).toEqual(['look_image', 'write_document'])
    expect(agent?.displays.map((item) => item.title)).toEqual(['图片解读'])
    expect(agent?.summary).toBe('图片中是一段要求写周报的文字\n\n已经写好了周报.docx')
    expect(loadedOf(events)).toEqual([['image'], ['image'], ['image', 'document']])
  })

  it('只是想看懂图片时，到此为止', async () => {
    const { result, calls } = run([
      text('{"task": true, "reason": "用户发了一张图片"}'),
      call('look_image', {}),
      text('图片中是一段文字'),
      text('{"task": false, "reason": "用户只是想看懂图片"}'),
    ])
    const agent = await result
    expect(calls).toHaveLength(4)
    expect(agent?.skills.map((skill) => skill.id)).toEqual(['image'])
    expect(agent?.toolCalls.map((item) => item.toolName)).toEqual(['look_image'])
  })

  it('模型已经自己加载了需要的技能时，不再判断', async () => {
    writeDocument.mockClear()
    const { result, calls } = run([
      text('{"task": true, "reason": "用户发了一张图片"}'),
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

  it('按顺序发出执行过程的事件，可以还原出每一轮的工具调用', async () => {
    const { createTrace, applyAgentEvent, traceStats } = await import('@/agent/trace')
    const { model } = scriptedModel([
      text('{"task": true, "reason": "要按图片做"}'),
      call('load_skills', { skillIds: ['picture'], reason: '要读图片' }),
      call('read_picture', {}),
      call('load_skills', { skillIds: ['document'], reason: '图片里要求写 Word 文档' }),
      call('write_document', { title: '周报' }),
      text('写好了'),
    ])
    const trace = createTrace()
    await runAgent({
      model,
      messages: [{ role: 'user', content: '照图片做' }],
      skills: [pictureSkill, documentSkill],
      onEvent: (event) => applyAgentEvent(trace, event),
    })

    expect(trace.nodes.map((node) => node.kind)).toEqual(['route', 'step', 'step', 'step', 'step', 'step'])
    const [route, ...steps] = trace.nodes
    expect(route).toMatchObject({ kind: 'route', status: 'done', task: true, reason: '要按图片做' })
    expect(steps.map((step) => step.kind === 'step' && step.tools.map((tool) => [tool.name, tool.status]))).toEqual([
      [['load_skills', 'done']],
      [['read_picture', 'done']],
      [['load_skills', 'done']],
      [['write_document', 'done']],
      [],
    ])
    expect(steps.map((step) => step.kind === 'step' && step.finishReason)).toEqual(['tool-calls', 'tool-calls', 'tool-calls', 'tool-calls', 'stop'])
    const write = steps[3]!.kind === 'step' ? steps[3]!.tools[0]! : undefined
    expect(write?.summary).toBe('title: 周报')
    expect(write?.output).toContain('周报.docx')
    expect(traceStats(trace)).toMatchObject({ rounds: 5, toolCalls: 4, failed: 0 })
  })

  it('轮数用完时不带工具再调用一次，根据执行记录总结', async () => {
    writeDocument.mockClear()
    const { createTrace, applyAgentEvent } = await import('@/agent/trace')
    const { model, calls } = scriptedModel([
      call('write_document', { title: '一月' }),
      call('write_document', { title: '二月' }),
      text('写好了一月和二月的周报，三月的还没写'),
    ])
    const { executeSkills } = await import('@/agent/executor')
    const trace = createTrace()
    const result = await executeSkills(
      { model, messages, skills: [documentSkill], onEvent: (event) => applyAgentEvent(trace, event) },
      [documentSkill],
      2,
    )

    expect(writeDocument).toHaveBeenCalledTimes(2)
    // 系统提示中说明了这次的轮数
    expect(systemOf(calls[0]!)).toContain('这次最多可以进行 2 轮工具调用')
    // 总结时没有工具，执行记录写在系统提示中，消息只有对话的文字
    const summary = calls[2]!
    expect(toolsOf(summary)).toEqual([])
    expect(systemOf(summary)).toContain('# 本次执行的记录')
    expect(systemOf(summary)).toContain('- 调用 write_document：title: 二月')
    const dialog = summary.prompt.filter((message) => message.role !== 'system')
    expect(dialog.map((message) => message.role)).toEqual(['user'])
    expect(JSON.stringify(dialog)).toContain('写一份很长的周报')
    expect(result).toMatchObject({ summary: '写好了一月和二月的周报，三月的还没写', stepLimitReached: true })
    expect(result.toolCalls).toHaveLength(2)
    // 执行过程中显示为「总结」，不算作一轮工具调用
    expect(trace.nodes.map((node) => node.kind === 'step' && (node.summary ? 'summary' : node.finishReason))).toEqual(['tool-calls', 'tool-calls', 'summary'])
  })

  it('复杂的任务允许更多轮的工具调用', async () => {
    writeDocument.mockClear()
    const { COMPLEX_MAX_STEPS } = await import('@/agent/executor')
    const rounds = 15
    const { model, calls } = scriptedModel([
      text('{"task": true, "complex": true, "reason": "要写很多份文档"}'),
      call('load_skills', { skillIds: ['document'], reason: '要写文档' }),
      ...Array.from({ length: rounds }, (_, i) => call('write_document', { title: `第 ${i + 1} 份` })),
      text('写好了 15 份'),
    ])
    const result = await runAgent({ model, messages, skills: [documentSkill] })

    expect(systemOf(calls[1]!)).toContain(`这次最多可以进行 ${COMPLEX_MAX_STEPS} 轮工具调用`)
    expect(writeDocument).toHaveBeenCalledTimes(rounds)
    expect(result).toMatchObject({ summary: '写好了 15 份' })
    expect(result?.stepLimitReached).toBeUndefined()
  })

  it('上下文超过预算时精简较早的工具结果，最近两轮保持原样', async () => {
    const { CONTEXT_BUDGET } = await import('@/agent/compact')
    // 每个结果约为预算的 40%：两轮的结果不超过预算，三轮的超过
    const big = 'x'.repeat(Math.ceil(CONTEXT_BUDGET * 0.4))
    const bigSkill: Skill = {
      id: 'big',
      name: '大文件',
      description: '读取很大的文件',
      instructions: '用 read_big 读取',
      tools: { read_big: tool({ description: '读取', inputSchema: z.object({}), execute: async () => ({ path: 'D:\\big.txt', content: big }) }) },
    }
    const { model, calls } = scriptedModel([call('read_big', {}), call('read_big', {}), call('read_big', {}), text('读完了')])
    const { executeSkills } = await import('@/agent/executor')
    await executeSkills({ model, messages, skills: [bigSkill] }, [bigSkill])

    const count = (options: CallOptions, value: string) => JSON.stringify(options.prompt).split(value).length - 1
    // 只有两轮的结果时，都在保护范围内，保持原样
    expect(count(calls[2]!, big)).toBe(2)
    expect(count(calls[2]!, '上下文太长已省略')).toBe(0)
    // 第三轮之后：第一轮的结果被精简，保留了路径
    expect(count(calls[3]!, big)).toBe(2)
    expect(count(calls[3]!, '上下文太长已省略')).toBe(1)
    expect(count(calls[3]!, 'D:\\\\big.txt')).toBe(3)
  })

  it('接口出错时报告真正的错误', async () => {
    const { model } = scriptedModel([new Error('401 Unauthorized')])
    const { executeSkills } = await import('@/agent/executor')
    const result = await executeSkills({ model, messages, skills: [documentSkill] }, [documentSkill])
    expect(result.error).toBe('401 Unauthorized')
  })
})
