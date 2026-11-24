import type { Skill } from '@/agent/types'
import { describe, expect, it } from 'vitest'
import { applyAgentEvent, createTrace, finishTrace, hasExecution, startReply, traceStats } from '@/agent/trace'
import { summarizeInput } from '@/agent/utils'

const fileSkill = { id: 'files', name: '本地文件' } as Skill

describe('执行过程', () => {
  it('记录意图识别、每一轮的工具调用与生成回复的耗时', () => {
    const trace = createTrace(0)
    applyAgentEvent(trace, { type: 'routing', stage: 'intent' }, 0)
    applyAgentEvent(trace, { type: 'routed', decision: { task: true, reason: '要读文件' } }, 500)
    applyAgentEvent(trace, { type: 'step-start' }, 500)
    applyAgentEvent(trace, { type: 'tool-input', toolCallId: 'a', toolName: 'read_file', chars: 0 }, 600)
    applyAgentEvent(trace, { type: 'tool-input', toolCallId: 'a', toolName: '', chars: 400 }, 700)
    applyAgentEvent(trace, { type: 'tool-call', toolCallId: 'a', toolName: 'read_file', input: { path: 'D:\\a.txt' } }, 800)
    applyAgentEvent(trace, { type: 'tool-result', toolCallId: 'a', record: { toolName: 'read_file', input: { path: 'D:\\a.txt' }, error: '文件不存在' } }, 900)
    applyAgentEvent(trace, { type: 'step-finish', finishReason: 'tool-calls', outputTokens: 42 }, 1000)
    startReply(trace, 1000)
    finishTrace(trace, 2000)

    const [route, step, reply] = trace.nodes
    expect(route).toMatchObject({ kind: 'route', status: 'done', startedAt: 0, endedAt: 500, task: true, reason: '要读文件' })
    expect(step).toMatchObject({ kind: 'step', status: 'done', finishReason: 'tool-calls', outputTokens: 42 })
    // 工具的耗时从开始执行算起，不包括模型编写参数的时间
    expect(step?.kind === 'step' && step.tools[0]).toMatchObject({
      name: 'read_file', status: 'error', startedAt: 800, endedAt: 900, chars: 400, summary: 'path: D:\\a.txt', error: '文件不存在',
    })
    expect(reply).toMatchObject({ kind: 'reply', status: 'done', startedAt: 1000, endedAt: 2000 })
    expect(traceStats(trace)).toEqual({ rounds: 1, toolCalls: 1, failed: 1, durationMs: 2000 })
  })

  it('不同轮次的工具调用 id 相同时（部分服务商每轮都从 call_0 开始）各自记在自己的轮次中', () => {
    const trace = createTrace(0)
    for (const [index, name] of ['search_files', 'read_file'].entries()) {
      applyAgentEvent(trace, { type: 'step-start' }, index * 100)
      applyAgentEvent(trace, { type: 'tool-call', toolCallId: 'call_0', toolName: name, input: {} }, index * 100)
      applyAgentEvent(trace, { type: 'tool-result', toolCallId: 'call_0', record: { toolName: name, input: {}, output: {} } }, index * 100 + 50)
      applyAgentEvent(trace, { type: 'step-finish', finishReason: 'tool-calls' }, index * 100 + 60)
    }
    expect(trace.nodes.map((node) => node.kind === 'step' && node.tools.map((tool) => [tool.name, tool.status]))).toEqual([
      [['search_files', 'done']],
      [['read_file', 'done']],
    ])
  })

  it('向用户提问时显示问题，回答后补上回答，没有回答时标出', () => {
    const trace = createTrace(0)
    const input = { question: '用哪个端口？', options: ['8080', '9090'] }
    applyAgentEvent(trace, { type: 'step-start' }, 0)
    applyAgentEvent(trace, { type: 'tool-call', toolCallId: 'a', toolName: 'ask_user', input }, 0)
    const tool = () => (trace.nodes[0]?.kind === 'step' ? trace.nodes[0].tools[0] : undefined)
    expect(tool()?.summary).toBe('问：用哪个端口？')

    applyAgentEvent(trace, { type: 'tool-result', toolCallId: 'a', record: { toolName: 'ask_user', input, output: { answered: false, note: '…' } } }, 100)
    expect(tool()?.summary).toBe('问：用哪个端口？ → 没有回答')
  })

  it('意图识别失败没有结果时，开始执行后结束识别', () => {
    const trace = createTrace(0)
    applyAgentEvent(trace, { type: 'routing' }, 0)
    applyAgentEvent(trace, { type: 'step-start' }, 300)
    expect(trace.nodes[0]).toMatchObject({ status: 'done', endedAt: 300 })
  })

  it('开始执行前预先加载的技能记在意图识别上，执行中加载的不记', () => {
    const trace = createTrace(0)
    applyAgentEvent(trace, { type: 'routing' }, 0)
    applyAgentEvent(trace, { type: 'routed', decision: { task: true, reason: '用户发了图片' } }, 100)
    applyAgentEvent(trace, { type: 'skills-loaded', skills: [{ id: 'image', name: '图片理解' } as Skill] }, 100)
    applyAgentEvent(trace, { type: 'step-start' }, 100)
    applyAgentEvent(trace, { type: 'skills-loaded', skills: [{ id: 'image', name: '图片理解' } as Skill, fileSkill] }, 200)
    expect(trace.nodes[0]).toMatchObject({ kind: 'route', preloaded: ['图片理解'] })
  })

  it('直接调用的工具不算一轮', () => {
    const trace = createTrace(0)
    applyAgentEvent(trace, { type: 'skills-loaded', skills: [fileSkill] }, 0)
    applyAgentEvent(trace, { type: 'tool-call', toolCallId: 'd', toolName: 'translate', input: { text: 'hi' } }, 0)
    applyAgentEvent(trace, { type: 'tool-result', toolCallId: 'd', record: { toolName: 'translate', input: { text: 'hi' }, output: { text: '你好' } } }, 100)

    expect(trace.nodes).toHaveLength(1)
    expect(trace.nodes[0]).toMatchObject({ kind: 'step', direct: true, status: 'done' })
    expect(traceStats(trace, 100)).toMatchObject({ rounds: 0, toolCalls: 1 })
  })

  it('执行阶段出错时，未完成的步骤标记为失败并记下原因', () => {
    const trace = createTrace(0)
    applyAgentEvent(trace, { type: 'step-start' }, 0)
    applyAgentEvent(trace, { type: 'tool-call', toolCallId: 'a', toolName: 'run_script', input: {} }, 100)
    startReply(trace, 500, '429 Too Many Requests')

    const step = trace.nodes[0]
    expect(step).toMatchObject({ status: 'error', endedAt: 500 })
    expect(step?.kind === 'step' && step.tools[0]?.status).toBe('error')
    expect(trace.error).toBe('429 Too Many Requests')
  })

  it('记录任务是否复杂；轮数用完后的总结单独标出，不算作一轮', () => {
    const trace = createTrace(0)
    applyAgentEvent(trace, { type: 'routing' }, 0)
    applyAgentEvent(trace, { type: 'routed', decision: { task: true, reason: '了解项目', complex: true } }, 100)
    applyAgentEvent(trace, { type: 'step-start' }, 100)
    applyAgentEvent(trace, { type: 'step-finish', finishReason: 'tool-calls' }, 200)
    applyAgentEvent(trace, { type: 'step-start', summary: true }, 200)
    applyAgentEvent(trace, { type: 'step-finish', finishReason: 'stop' }, 300)

    expect(trace.nodes[0]).toMatchObject({ kind: 'route', complex: true })
    expect(trace.nodes[2]).toMatchObject({ kind: 'step', summary: true, status: 'done' })
    expect(traceStats(trace, 300).rounds).toBe(1)
  })

  it('普通闲聊没有执行过工具', () => {
    const trace = createTrace(0)
    applyAgentEvent(trace, { type: 'routing' }, 0)
    applyAgentEvent(trace, { type: 'routed', decision: { task: false, reason: '闲聊' } }, 100)
    startReply(trace, 100)
    expect(trace.nodes[0]).toMatchObject({ kind: 'route', task: false })
    expect(hasExecution(trace)).toBe(false)
  })

  it('参数摘要只保留一行的要点', () => {
    expect(summarizeInput({ path: 'D:\\notes.txt', overwrite: true, skip: undefined })).toBe('path: D:\\notes.txt，overwrite: true')
    expect(summarizeInput({ skillIds: ['document', 'files'], content: '第一行\n第二行' })).toBe('skillIds: document、files，content: 第一行 第二行')
    expect(summarizeInput({ moves: [{ from: 'a', to: 'b' }] })).toBe('moves: 1 项')
    expect(summarizeInput({ code: 'x'.repeat(100) })).toBe(`code: ${'x'.repeat(80)}…（已截断）`)
  })
})
