import type { ModelMessage } from 'ai'
import type { AgentResult, Skill } from '@/agent/types'
import { describe, expect, it } from 'vitest'
import { buildToolLog, compactToolMessages, compactValue } from '@/agent/compact'
import { appendToolLog, buildAgentContextPrompt } from '@/agent/prompts'

const LONG = '很长的内容'.repeat(100)

describe('精简数据', () => {
  it('长字符串换成字数说明，短字段保持原样', () => {
    expect(compactValue({ path: 'D:\\a.txt', content: LONG, count: 3 })).toEqual({
      path: 'D:\\a.txt',
      content: '（共 500 字，已省略）',
      count: 3,
    })
  })

  it('数组只保留前几项，嵌套过深的部分省略，可以去掉指定的字段', () => {
    expect(compactValue({ items: [1, 2, 3, 4] }, { maxItems: 2 })).toEqual({ items: [1, 2, '（还有 2 项）'] })
    expect(compactValue({ a: { b: { c: 1 } } }, { maxDepth: 2 })).toEqual({ a: { b: '{…}' } })
    expect(compactValue({ text: '译文', display: { title: '翻译', content: '译文' } }, { omitKeys: ['display'] })).toEqual({ text: '译文' })
  })
})

/** 一轮工具调用：发起调用的消息与工具结果 */
function step(id: string, input: unknown, output: unknown): ModelMessage[] {
  return [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: 'read_file', input }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: 'read_file', output: { type: 'json', value: output as never } }] },
  ]
}

describe('工具执行中精简上下文', () => {
  const user: ModelMessage = { role: 'user', content: '看看这个项目' }

  it('没有超过预算时原样返回', () => {
    const messages = [user, ...step('1', { path: 'a' }, { content: LONG })]
    expect(compactToolMessages(messages, 100_000)).toBe(messages)
  })

  it('超过预算时从最早的开始精简工具结果，最近两轮保持原样', () => {
    const messages = [
      user,
      ...step('1', { path: 'D:\\a.ts' }, { path: 'D:\\a.ts', content: LONG }),
      ...step('2', { path: 'D:\\b.ts' }, { path: 'D:\\b.ts', content: LONG }),
      ...step('3', { path: 'D:\\c.ts' }, { path: 'D:\\c.ts', content: LONG }),
    ]
    const compacted = compactToolMessages(messages, 2000)
    const outputOf = (message: ModelMessage) => message.role === 'tool' && message.content[0]?.type === 'tool-result' ? message.content[0].output : undefined

    // 第一轮被精简：保留路径，省略长内容
    expect(outputOf(compacted[2]!)).toEqual({ type: 'json', value: { path: 'D:\\a.ts', content: expect.stringContaining('上下文太长已省略') } })
    // 最近两轮保持原样
    expect(compacted.slice(3)).toEqual(messages.slice(3))
    // 用户消息不受影响，也不会改动原来的消息
    expect(compacted[0]).toBe(user)
    expect(outputOf(messages[2]!)).toEqual({ type: 'json', value: { path: 'D:\\a.ts', content: LONG } })
  })

  it('也精简较早的工具参数中的长内容（如写入文件的内容）', () => {
    const messages = [
      user,
      ...step('1', { path: 'D:\\a.ts', content: LONG }, { written: true }),
      ...step('2', { path: 'D:\\b.ts' }, { content: LONG }),
      ...step('3', { path: 'D:\\c.ts' }, { content: LONG }),
    ]
    const compacted = compactToolMessages(messages, 1500)
    const call = compacted[1]!
    expect(call.role === 'assistant' && Array.isArray(call.content) && call.content[0]).toMatchObject({
      type: 'tool-call',
      input: { path: 'D:\\a.ts', content: expect.stringContaining('已省略') },
    })
  })

  it('精简到不超过预算就停止', () => {
    const messages = [
      user,
      ...step('1', {}, { content: LONG }),
      ...step('2', {}, { content: LONG }),
      ...step('3', {}, { content: LONG }),
      ...step('4', {}, { content: LONG }),
    ]
    const full = JSON.stringify(messages).length
    // 精简一轮可以省下约 470 字，预算只需要精简一轮
    const compacted = compactToolMessages(messages, full - 300)
    expect(JSON.stringify(compacted[2])).toContain('已省略')
    expect(compacted[4]).toBe(messages[4])
  })
})

const fileSkill = { id: 'files', name: '本地文件', tools: { search_files: {}, read_file: {} } } as unknown as Skill

function agentResult(overrides: Partial<AgentResult>): AgentResult {
  return { skills: [fileSkill], toolCalls: [], displays: [], summary: '', ...overrides }
}

describe('工具调用记录', () => {
  it('记录每次调用的技能、工具、关键参数与简短的结果，以及执行总结', () => {
    const log = buildToolLog(agentResult({
      toolCalls: [
        {
          toolName: 'search_files',
          input: { keywords: ['合同'] },
          output: { count: 2, files: [{ name: '合同.pdf', path: 'D:\\下载\\合同.pdf' }, { name: '合同2.pdf', path: 'D:\\下载\\合同2.pdf' }] },
        },
        { toolName: 'read_file', input: { path: 'D:\\下载\\合同.pdf' }, error: '扫描件 PDF 没有文字' },
        { toolName: 'translate', input: { text: 'hi' }, output: { display: { title: '翻译', content: '你好' } } },
      ],
      summary: '找到两份合同，第一份是扫描件读不出文字',
    }))

    const lines = log.split('\n')
    expect(lines[0]).toBe('1. 本地文件 · search_files（keywords: 合同） → 成功：{"count":2,"files":[{"name":"合同.pdf","path":"D:\\\\下载\\\\合同.pdf"},{"name":"合同2.pdf","path":"D:\\\\下载\\\\合同2.pdf"}]}')
    expect(lines[1]).toBe('2. 本地文件 · read_file（path: D:\\下载\\合同.pdf） → 失败：扫描件 PDF 没有文字')
    // 结果卡片已经保留在对话历史中，不重复记录
    expect(lines[2]).toBe('3. translate（text: hi） → 成功')
    expect(lines[3]).toBe('执行总结：找到两份合同，第一份是扫描件读不出文字')
  })

  it('长内容只记字数，调用太多时只记最近的几次', () => {
    const log = buildToolLog(agentResult({
      toolCalls: Array.from({ length: 12 }, (_, i) => ({ toolName: 'read_file', input: { path: `D:\\${i}.txt` }, output: { content: LONG } })),
    }))
    expect(log).toContain('（更早的 2 次调用已省略）')
    expect(log).toContain('path: D:\\11.txt')
    expect(log).not.toContain('path: D:\\1.txt）')
    expect(log).toContain('{"content":"（500 字）"}')
  })

  it('没有可记录的内容时为空，附加到回复时不改动回复', () => {
    expect(buildToolLog(agentResult({}))).toBe('')
    expect(appendToolLog('好的', '')).toBe('好的')
    expect(appendToolLog('好的', '1. read_file → 成功')).toBe('好的\n\n【这一轮的工具调用记录（系统自动附加，只有工具执行模块能看到）】\n1. read_file → 成功')
  })
})

describe('交给角色扮演阶段的执行结果', () => {
  it('有执行总结时工具结果截得更短，只列出最近的几次调用', () => {
    const prompt = buildAgentContextPrompt(agentResult({
      toolCalls: Array.from({ length: 15 }, (_, i) => ({ toolName: 'read_file', input: { path: `${i}.ts` }, output: { content: 'x'.repeat(6000) } })),
      summary: '项目分为三层',
    }))
    expect(prompt).toContain('（更早的 3 次调用省略，结论见执行总结）')
    expect(prompt).toContain('4. read_file')
    expect(prompt).toContain('x'.repeat(900))
    expect(prompt).not.toContain('x'.repeat(1100))
  })

  it('没有执行总结时保留更长的结果', () => {
    const prompt = buildAgentContextPrompt(agentResult({
      toolCalls: [{ toolName: 'read_file', input: { path: 'a.ts' }, output: { content: 'x'.repeat(6000) } }],
    }))
    expect(prompt).toContain('x'.repeat(3900))
    expect(prompt).not.toContain('x'.repeat(4100))
  })

  it('轮数用完时说明任务没有全部完成，可以让用户说「继续」', () => {
    const prompt = buildAgentContextPrompt(agentResult({ summary: '已经看完了 src/agent', stepLimitReached: true }))
    expect(prompt).toContain('工具调用轮数用完了')
    expect(prompt).toContain('「继续」')
  })
})
