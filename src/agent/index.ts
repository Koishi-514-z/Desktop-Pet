import type { AgentResult, AgentRunOptions } from '@/agent/types'
import { executeSkills } from '@/agent/executor'
import { routeIntent } from '@/agent/router'
import { errorMessage } from '@/agent/utils'

export type * from '@/agent/types'
export { buildAgentContextPrompt, buildEventMessage } from '@/agent/prompts'

/**
 * 运行 Agent 的前两个阶段：
 * 1. 意图识别：判断用户的最新消息需要哪些技能；
 * 2. 工具执行：加载被选中技能的说明与工具，由 LLM 调用工具完成请求。
 *
 * 返回 null 表示无需使用技能（普通闲聊），此时直接由角色扮演阶段回复即可。
 * 第三阶段（角色润色）由调用方把返回结果通过 buildAgentContextPrompt 附加到人设提示词上完成。
 */
export async function runAgent(options: AgentRunOptions): Promise<AgentResult | null> {
  const { skills, onEvent, abortSignal } = options
  if (skills.length === 0) return null

  onEvent?.({ type: 'routing' })
  let selected
  try {
    const decision = await routeIntent(options)
    selected = skills.filter((skill) => decision.skillIds.includes(skill.id))
    console.debug('[agent] 意图识别：', decision)
    onEvent?.({ type: 'routed', decision, skills: selected })
  }
  catch (error) {
    if (abortSignal?.aborted) throw error
    // 意图识别失败不影响正常聊天，退化为普通对话
    console.warn('[agent] 意图识别失败，按普通对话处理：', errorMessage(error))
    return null
  }

  if (selected.length === 0) return null

  const result = await executeSkills({ ...options, skills: selected })
  console.debug('[agent] 工具执行：', result)
  return result
}
