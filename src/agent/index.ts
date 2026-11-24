import type { AgentResult, AgentRunOptions } from '@/agent/types'
import { extractDisplay } from '@/agent/context'
import { executeDirectCall, executeSkills } from '@/agent/executor'
import { buildImageRequestBackground } from '@/agent/prompts'
import { routeImageRequest, routeIntent } from '@/agent/router'
import { IMAGE_SKILL_ID } from '@/agent/skills/image'
import { errorMessage } from '@/agent/utils'

export type * from '@/agent/types'
export { getSkillContext } from '@/agent/context'
export { buildAgentContextPrompt, buildEventMessage } from '@/agent/prompts'

/**
 * 运行 Agent 的前两个阶段：
 * 1. 意图识别：判断用户的最新消息需要哪些技能；
 * 2. 工具执行：加载被选中技能的说明与工具，由 LLM 调用工具完成请求（执行中可以按需加载其他技能）。
 *    用户把要求写在图片里时，读出图片后再识别一次意图，用需要的技能继续完成。
 *
 * 指定了 directCall 时跳过以上两个阶段的 LLM，直接调用工具。
 *
 * 返回 null 表示无需使用技能（普通闲聊），此时直接由角色扮演阶段回复即可。
 * 第三阶段（角色润色）由调用方把返回结果通过 buildAgentContextPrompt 附加到人设提示词上完成。
 */
export async function runAgent(options: AgentRunOptions): Promise<AgentResult | null> {
  const { skills, directCall, onEvent, abortSignal } = options

  if (directCall) {
    const result = await executeDirectCall(options, directCall)
    console.debug('[agent] 直接调用：', result)
    return result
  }

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

  // 执行中可以按需加载其他可用的技能（如识别图片后发现图中的要求需要别的技能）
  const result = await executeSkills(options, selected)
  console.debug('[agent] 工具执行：', result)
  return continueWithImageRequest(options, result)
}

/**
 * 用户把要求写在图片里时继续完成。意图识别看不到图片的内容，只会选择图片理解；
 * 执行阶段读出图片后，模型不一定会意识到图中的文字就是要它完成的任务。
 * 因此这一轮只用了图片理解时，带着读出的图片内容再识别一次意图，需要其他技能时继续执行。
 *
 * 只针对用户自己发来的图片；网页、文件中的内容是第三方的，其中的指令不会因此被执行。
 */
async function continueWithImageRequest(options: AgentRunOptions, result: AgentResult): Promise<AgentResult> {
  const { skills, onEvent, abortSignal } = options
  const onlyImage = result.skills.length > 0 && result.skills.every((skill) => skill.id === IMAGE_SKILL_ID)
  if (!onlyImage || result.error !== undefined) return result

  const imageContent = result.toolCalls
    .filter((call) => call.error === undefined)
    .map((call) => extractDisplay(call.output)?.content)
    .filter(Boolean)
    .join('\n\n')
  const candidates = skills.filter((skill) => skill.id !== IMAGE_SKILL_ID)
  if (!imageContent || candidates.length === 0) return result

  let next
  try {
    const decision = await routeImageRequest({ ...options, skills: candidates }, imageContent)
    console.debug('[agent] 图片中的要求：', decision)
    next = candidates.filter((skill) => decision.skillIds.includes(skill.id))
    if (next.length === 0) return result
    onEvent?.({ type: 'routed', decision, skills: [...result.skills, ...next] })
  }
  catch (error) {
    if (abortSignal?.aborted) throw error
    // 判断失败时保留已经得到的图片理解结果
    console.warn('[agent] 识别图片中的要求失败：', errorMessage(error))
    return result
  }

  // 继续执行：图片内容加入系统提示；保留图片理解技能，必要时可以重新读取图片的原文
  const background = [await Promise.resolve(options.background).catch(() => ''), buildImageRequestBackground(imageContent)]
    .filter(Boolean)
    .join('\n\n')
  const followUp = await executeSkills({ ...options, background }, [...result.skills, ...next])
  console.debug('[agent] 按图片中的要求执行：', followUp)
  return {
    skills: followUp.skills,
    toolCalls: [...result.toolCalls, ...followUp.toolCalls],
    displays: [...result.displays, ...followUp.displays],
    summary: [result.summary, followUp.summary].filter(Boolean).join('\n\n'),
    ...(followUp.error !== undefined ? { error: followUp.error } : {}),
  }
}
