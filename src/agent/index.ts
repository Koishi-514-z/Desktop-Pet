import type { AgentResult, AgentRunOptions, RouteDecision, Skill } from '@/agent/types'
import { extractDisplay } from '@/agent/context'
import { executeDirectCall, executeSkills, stepBudget } from '@/agent/executor'
import { buildImageRequestBackground, PROACTIVE_EXECUTOR_NOTE } from '@/agent/prompts'
import { routeImageRequest, routeIntent } from '@/agent/router'
import { IMAGE_SKILL_ID, parseImageIds } from '@/agent/skills/image'
import { QUOTE_MARKER, SELECTION_SKILL_ID } from '@/agent/skills/selection'
import { errorMessage, messageText } from '@/agent/utils'
import { AUDIO_SKILL_ID, parseAudioIds } from '@/utils/audios'

export type * from '@/agent/types'
export { getSkillContext } from '@/agent/context'
export { buildAgentContextPrompt, buildEventMessage } from '@/agent/prompts'

/**
 * 运行 Agent 的前两个阶段：
 * 1. 意图识别：用便宜快速的小模型（routerModel）判断用户的最新消息是普通闲聊还是任务；
 *    是任务时把请求拆成几个步骤，选出完成所有步骤需要的技能（如「提取语音内容并翻译」需要音频理解与文字处理）；
 * 2. 工具执行：开始时一次加载意图识别选出的技能与消息中的附件需要的技能，调用工具完成请求；
 *    还需要其他技能时，执行模型可以根据技能目录用 load_skills 加载。
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

  // 开始时一次加载需要的技能（还缺的由执行模块自己加载）；需要较多步骤的任务允许更多轮的工具调用，并要求先制定计划
  const preloaded = preloadedSkills(options, decision)
  const result = await executeSkills(options, preloaded, stepBudget(decision), decision.complex === true, decision.steps)
  console.debug('[agent] 工具执行：', result)
  // 执行模块没有加载技能、也没有调用工具，即判断不需要技能（如闲聊、常识问答）时，按普通对话处理
  if (result.toolCalls.length === 0 && result.error === undefined && result.skills.length === preloaded.length) return null
  return continueWithImageRequest(options, result)
}

/**
 * 主动交互：桌宠准备主动说话前，用指定的技能获取需要的信息（如天气、待办）。
 * 已经由主动交互模块判断过要说什么、需要哪些技能，因此不经过意图识别，技能全部预先加载；
 * 用户没有提出请求，也不一定在看着，所以不请求授权、不向用户提问。没有获取到任何信息时返回 null
 */
export async function runProactiveAgent(options: AgentRunOptions): Promise<AgentResult | null> {
  if (options.skills.length === 0) return null
  const background = [await Promise.resolve(options.background).catch(() => ''), PROACTIVE_EXECUTOR_NOTE].filter(Boolean).join('\n\n')
  const result = await executeSkills({ ...options, background, requestPermission: undefined, askUser: undefined }, options.skills)
  console.debug('[agent] 主动交互获取信息：', result)
  return result.toolCalls.length === 0 && result.error === undefined ? null : result
}

/**
 * 开始执行时预先加载的技能，省去加载技能的调用，也避免多步骤的请求只加载了第一步的技能：
 * - 意图识别选出的技能（只保留可用的）；
 * - 从消息中明确的标记就能确定的技能：附带了图片时需要图片理解才能看到图片的内容，附带了音频时需要音频理解，
 *   附带了划词内容时需要文字处理读取全文
 */
export function preloadedSkills(options: Pick<AgentRunOptions, 'messages' | 'skills'>, decision?: Pick<RouteDecision, 'skills'>): Skill[] {
  const needed = new Set<string>(decision?.skills ?? [])
  const latest = options.messages.at(-1)
  if (latest?.role === 'user') {
    const text = messageText(latest)
    if (parseImageIds(text).length) needed.add(IMAGE_SKILL_ID)
    if (parseAudioIds(text).length) needed.add(AUDIO_SKILL_ID)
    if (text.includes(QUOTE_MARKER)) needed.add(SELECTION_SKILL_ID)
  }
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

  // 继续执行：图片内容加入系统提示；保留图片理解技能（必要时可以重新读取图片的原文），
  // 并加载判断出的、完成图中要求需要的技能，还缺的由执行模块加载
  const background = [await Promise.resolve(options.background).catch(() => ''), buildImageRequestBackground(imageContent)]
    .filter(Boolean)
    .join('\n\n')
  const needed = candidates.filter((skill) => decision.skills?.includes(skill.id))
  const preloaded = [...result.skills, ...needed.filter((skill) => !result.skills.includes(skill))]
  const followUp = await executeSkills({ ...options, background }, preloaded, stepBudget(decision), decision.complex === true, decision.steps)
  console.debug('[agent] 按图片中的要求执行：', followUp)
  // 执行模块最后认为不需要做什么时，保留已经得到的图片理解结果
  if (followUp.toolCalls.length === 0 && followUp.error === undefined && followUp.skills.length === preloaded.length) return result
  return {
    skills: followUp.skills,
    toolCalls: [...result.toolCalls, ...followUp.toolCalls],
    displays: [...result.displays, ...followUp.displays],
    summary: [result.summary, followUp.summary].filter(Boolean).join('\n\n'),
    ...(followUp.error !== undefined ? { error: followUp.error } : {}),
    ...(followUp.stepLimitReached ? { stepLimitReached: true } : {}),
    ...((followUp.plan ?? result.plan) ? { plan: followUp.plan ?? result.plan } : {}),
  }
}
