import type { ToolSet } from 'ai'
import type { AgentResult, AgentRunOptions, Skill, ToolCallRecord } from '@/agent/types'
import { generateText, stepCountIs } from 'ai'
import { buildExecutorSystemPrompt } from '@/agent/prompts'
import { errorMessage, recentMessages } from '@/agent/utils'

// 工具执行阶段参考的最近消息条数
const EXECUTOR_CONTEXT_SIZE = 10
// 单次执行最多进行的 LLM 调用轮数（每轮可调用若干工具），防止死循环
const MAX_STEPS = 6

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
  const recordedIds = new Set<string>()

  try {
    const { text, steps } = await generateText({
      model,
      system: buildExecutorSystemPrompt(skills),
      messages: recentMessages(messages, EXECUTOR_CONTEXT_SIZE),
      tools: collectTools(skills),
      stopWhen: stepCountIs(MAX_STEPS),
      temperature: 0,
      abortSignal,
      experimental_onToolCallStart: ({ toolCall }) => {
        onEvent?.({ type: 'tool-call', toolName: toolCall.toolName, input: toolCall.input })
      },
      experimental_onToolCallFinish: (event) => {
        const record: ToolCallRecord = { toolName: event.toolCall.toolName, input: event.toolCall.input }
        if (event.success) record.output = event.output
        else record.error = errorMessage(event.error)
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

    return { skills, toolCalls, summary: text }
  }
  catch (error) {
    if (abortSignal?.aborted) throw error
    return { skills, toolCalls, summary: '', error: errorMessage(error) }
  }
}
