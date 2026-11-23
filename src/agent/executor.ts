import type { ToolSet } from 'ai'
import type { AgentResult, AgentRunOptions, DirectToolCall, Skill, SkillContext, ToolCallRecord, ToolDisplay } from '@/agent/types'
import { generateText, stepCountIs } from 'ai'
import { extractDisplay } from '@/agent/context'
import { buildExecutorSystemPrompt } from '@/agent/prompts'
import { errorMessage, recentMessages } from '@/agent/utils'

// 工具执行阶段参考的最近消息条数
const EXECUTOR_CONTEXT_SIZE = 10
// 单次执行最多进行的 LLM 调用轮数（每轮可调用若干工具），防止死循环
const MAX_STEPS = 6

function createSkillContext(options: AgentRunOptions): SkillContext {
  const { model, visionModel, abortSignal, requestPermission, attachImages, setStatus } = options
  return { model, visionModel: visionModel ?? model, abortSignal, requestPermission, attachImages, setStatus }
}

/** 合并多个技能的工具，工具名重复时后者会被忽略 */
export function collectTools(skills: Skill[]): ToolSet {
  const tools: ToolSet = {}
  for (const skill of skills) {
    for (const [name, tool] of Object.entries(skill.tools)) {
      if (name in tools) {
        console.warn(`[agent] 技能 ${skill.id} 的工具 ${name} 与其他技能重名，已忽略`)
        continue
      }
      tools[name] = tool
    }
  }
  return tools
}

/** 阶段二：工具执行。由 LLM 根据已激活技能的说明自主调用工具（可多轮），并总结执行结果 */
export async function executeSkills(options: AgentRunOptions): Promise<AgentResult> {
  const { model, messages, skills, onEvent, abortSignal } = options
  const toolCalls: ToolCallRecord[] = []
  const displays: ToolDisplay[] = []
  const recordedIds = new Set<string>()
  const context = createSkillContext(options)

  try {
    // 背景信息准备失败不影响执行
    const background = await Promise.resolve(options.background).catch(() => '')
    const { text, steps } = await generateText({
      model,
      system: buildExecutorSystemPrompt(skills, new Date(), background),
      messages: recentMessages(messages, EXECUTOR_CONTEXT_SIZE),
      tools: collectTools(skills),
      stopWhen: stepCountIs(MAX_STEPS),
      temperature: 0,
      abortSignal,
      experimental_context: context,
      experimental_onToolCallStart: ({ toolCall }) => {
        onEvent?.({ type: 'tool-call', toolName: toolCall.toolName, input: toolCall.input })
      },
      experimental_onToolCallFinish: (event) => {
        const record: ToolCallRecord = { toolName: event.toolCall.toolName, input: event.toolCall.input }
        if (event.success) {
          record.output = event.output
          const display = extractDisplay(event.output)
          if (display) displays.push(display)
        }
        else {
          record.error = errorMessage(event.error)
        }
        recordedIds.add(event.toolCall.toolCallId)
        toolCalls.push(record)
        onEvent?.({ type: 'tool-result', record })
      },
    })

    // 参数校验失败、调用了不存在的工具等情况不会执行工具，也就不会触发上面的回调，这里从步骤记录中补上
    for (const part of steps.flatMap((step) => step.content)) {
      if (part.type !== 'tool-error' || recordedIds.has(part.toolCallId)) continue
      toolCalls.push({ toolName: part.toolName, input: part.input, error: errorMessage(part.error) })
    }

    return { skills, toolCalls, displays, summary: text }
  }
  catch (error) {
    if (abortSignal?.aborted) throw error
    return { skills, toolCalls, displays, summary: '', error: errorMessage(error) }
  }
}

/** 直接调用指定工具（不经过 LLM 选择工具），结果同样交给角色扮演阶段润色 */
export async function executeDirectCall(options: AgentRunOptions, call: DirectToolCall): Promise<AgentResult> {
  const { messages, skills, onEvent, abortSignal } = options

  const skill = skills.find((s) => s.id === call.skillId)
  if (!skill) throw new Error(`技能 ${call.skillId} 未启用`)
  const tool = skill.tools[call.toolName]
  if (!tool?.execute) throw new Error(`技能 ${call.skillId} 中没有可执行的工具 ${call.toolName}`)

  onEvent?.({ type: 'routed', decision: { skillIds: [skill.id], reason: '直接调用' }, skills: [skill] })
  onEvent?.({ type: 'tool-call', toolName: call.toolName, input: call.input })

  const record: ToolCallRecord = { toolName: call.toolName, input: call.input }
  const displays: ToolDisplay[] = []
  try {
    const context = createSkillContext(options)
    const result = tool.execute(call.input, {
      toolCallId: `direct-${Date.now()}`,
      messages,
      abortSignal,
      experimental_context: context,
    })
    // execute 也可以是流式返回的异步迭代器，此时以最后一个值为结果
    let output: unknown
    if (result && typeof result === 'object' && Symbol.asyncIterator in result) {
      for await (const value of result as AsyncIterable<unknown>) output = value
    }
    else {
      output = await result
    }
    record.output = output
    const display = extractDisplay(output)
    if (display) displays.push(display)
  }
  catch (error) {
    if (abortSignal?.aborted) throw error
    record.error = errorMessage(error)
  }

  onEvent?.({ type: 'tool-result', record })
  return { skills: [skill], toolCalls: [record], displays, summary: '' }
}
