import type { AgentResult, AgentRunOptions, RouteDecision, Skill } from '@/agent/types'
import { extractDisplay } from '@/agent/context'
import { executeDirectCall, executeSkills, stepBudget } from '@/agent/executor'
import { buildImageRequestBackground } from '@/agent/prompts'
import { routeImageRequest, routeIntent } from '@/agent/router'
import { IMAGE_SKILL_ID, parseImageIds } from '@/agent/skills/image'
import { QUOTE_MARKER, SELECTION_SKILL_ID } from '@/agent/skills/selection'
import { errorMessage, messageText } from '@/agent/utils'

export type * from '@/agent/types'
export { getSkillContext } from '@/agent/context'
export { buildAgentContextPrompt, buildEventMessage } from '@/agent/prompts'

/**
 * 运行 Agent 的前两个阶段：
 * 1. 意图识别：用便宜快速的小模型（routerModel）判断用户的最新消息是普通闲聊还是任务，不选择技能；
 * 2. 工具执行：由执行模型根据技能目录加载需要的技能，调用工具完成请求。
 *    用户把要求写在图片里时，读出图片后再判断一次，图中是要完成的任务时继续执行。
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

  onEvent?.({ type: 'routing', stage: 'intent' })
  let decision: RouteDecision
  try {
    decision = await routeIntent({ ...options, model: options.routerModel ?? options.model })
  }
  catch (error) {
    if (abortSignal?.aborted) throw error
    // 意图识别失败（如小模型的配置有误）时交给执行模块判断，以免所有任务都被当成闲聊
    console.warn('[agent] 意图识别失败，交给执行模块判断：', errorMessage(error))
    decision = { task: true, reason: '意图识别失败，交给执行模块判断' }
  }
  console.debug('[agent] 意图识别：', decision)
  onEvent?.({ type: 'routed', decision })
  if (!decision.task) return null

  // 需要哪些技能由执行模块自己加载；需要较多步骤的任务允许更多轮的工具调用
  const preloaded = preloadedSkills(options)
  const result = await executeSkills(options, preloaded, stepBudget(decision))
  console.debug('[agent] 工具执行：', result)
  // 执行模块没有加载技能、也没有调用工具，即判断不需要技能（如闲聊、常识问答）时，按普通对话处理
  if (result.toolCalls.length === 0 && result.error === undefined && result.skills.length === preloaded.length) return null
  return continueWithImageRequest(options, result)
}

/**
 * 从消息中明确的标记就能确定需要的技能，开始执行时预先加载，省去一轮加载技能的调用：
 * 用户的最新消息附带了图片时，需要图片理解才能看到图片的内容；附带了划词内容时，需要划词助手读取全文
 */
function preloadedSkills(options: AgentRunOptions): Skill[] {
  const latest = options.messages.at(-1)
  if (latest?.role !== 'user') return []
  const text = messageText(latest)
  const needed = new Set<string>()
  if (parseImageIds(text).length) needed.add(IMAGE_SKILL_ID)
  if (text.includes(QUOTE_MARKER)) needed.add(SELECTION_SKILL_ID)
  return options.skills.filter((skill) => needed.has(skill.id))
}

/**
 * 用户把要求写在图片里时继续完成。意图识别看不到图片的内容；
 * 执行阶段读出图片后，模型不一定会意识到图中的文字就是要它完成的任务。
 * 因此这一轮只用了图片理解时，带着读出的图片内容再判断一次，图中是要完成的任务时继续执行。
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

  let decision: RouteDecision
  onEvent?.({ type: 'routing', stage: 'image' })
  try {
    decision = await routeImageRequest({ ...options, model: options.routerModel ?? options.model, skills: candidates }, imageContent)
    console.debug('[agent] 图片中的要求：', decision)
    onEvent?.({ type: 'routed', decision })
    if (!decision.task) return result
  }
  catch (error) {
    if (abortSignal?.aborted) throw error
    // 判断失败时保留已经得到的图片理解结果
    console.warn('[agent] 判断图片中的要求失败：', errorMessage(error))
    return result
  }

  // 继续执行：图片内容加入系统提示；保留图片理解技能（必要时可以重新读取图片的原文），其余的技能由执行模块加载
  const background = [await Promise.resolve(options.background).catch(() => ''), buildImageRequestBackground(imageContent)]
    .filter(Boolean)
    .join('\n\n')
  const followUp = await executeSkills({ ...options, background }, result.skills, stepBudget(decision))
  console.debug('[agent] 按图片中的要求执行：', followUp)
  // 执行模块最后认为不需要做什么时，保留已经得到的图片理解结果
  if (followUp.toolCalls.length === 0 && followUp.error === undefined && followUp.skills.length === result.skills.length) return result
  return {
    skills: followUp.skills,
    toolCalls: [...result.toolCalls, ...followUp.toolCalls],
    displays: [...result.displays, ...followUp.displays],
    summary: [result.summary, followUp.summary].filter(Boolean).join('\n\n'),
    ...(followUp.error !== undefined ? { error: followUp.error } : {}),
    ...(followUp.stepLimitReached ? { stepLimitReached: true } : {}),
  }
}
