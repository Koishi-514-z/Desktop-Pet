import type { LanguageModel, ModelMessage } from 'ai'
import type { RouteDecision, Skill } from '@/agent/types'
import { generateText } from 'ai'
import { buildImageRequestPrompt, buildImageRequestSystemPrompt, buildRouterPrompt, buildRouterSystemPrompt } from '@/agent/prompts'
import { recentMessages } from '@/agent/utils'

// 意图识别时参考的最近消息条数（含用户的最新消息）
const ROUTER_CONTEXT_SIZE = 6

/**
 * 从 LLM 的输出中解析意图识别结果。
 * 兼容代码块包裹、前后夹带说明文字等情况；无法解析时视为不需要技能。
 */
export function parseRouteDecision(text: string, validSkillIds: string[]): RouteDecision {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return { skillIds: [], reason: '无法解析意图识别结果' }

  try {
    const data = JSON.parse(match[0]) as { skills?: unknown, reason?: unknown }
    const ids = Array.isArray(data.skills) ? data.skills : []
    const skillIds = [...new Set(ids.filter((id): id is string => typeof id === 'string' && validSkillIds.includes(id)))]
    return { skillIds, reason: typeof data.reason === 'string' ? data.reason : '' }
  }
  catch {
    return { skillIds: [], reason: '无法解析意图识别结果' }
  }
}

/** 阶段一：意图识别。判断用户的最新消息需要激活哪些技能 */
export async function routeIntent(options: {
  model: LanguageModel
  messages: ModelMessage[]
  skills: Skill[]
  abortSignal?: AbortSignal
}): Promise<RouteDecision> {
  const { model, messages, skills, abortSignal } = options
  if (skills.length === 0) return { skillIds: [], reason: '没有可用的技能' }

  const { text } = await generateText({
    model,
    system: buildRouterSystemPrompt(skills),
    prompt: buildRouterPrompt(recentMessages(messages, ROUTER_CONTEXT_SIZE)),
    temperature: 0,
    abortSignal,
  })

  return parseRouteDecision(text, skills.map((skill) => skill.id))
}

/**
 * 读出用户发来的图片之后再识别一次意图：意图识别时看不到图片，用户把要求写在图片里时（如截图发来一段需求），
 * 读出图片后才知道要做什么。返回完成图片中的要求需要的技能；只是想看懂图片时返回空列表
 */
export async function routeImageRequest(options: {
  model: LanguageModel
  messages: ModelMessage[]
  skills: Skill[]
  abortSignal?: AbortSignal
}, imageContent: string): Promise<RouteDecision> {
  const { model, messages, skills, abortSignal } = options
  if (skills.length === 0) return { skillIds: [], reason: '没有可用的技能' }

  const { text } = await generateText({
    model,
    system: buildImageRequestSystemPrompt(skills),
    prompt: buildImageRequestPrompt(recentMessages(messages, ROUTER_CONTEXT_SIZE), imageContent),
    temperature: 0,
    abortSignal,
  })

  return parseRouteDecision(text, skills.map((skill) => skill.id))
}
