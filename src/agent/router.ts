import type { LanguageModel, ModelMessage } from 'ai'
import type { RouteDecision, Skill } from '@/agent/types'
import { generateText } from 'ai'
import { buildImageRequestPrompt, buildImageRequestSystemPrompt, buildRouterPrompt, buildRouterSystemPrompt } from '@/agent/prompts'
import { parseJsonObject, recentMessages } from '@/agent/utils'

// 意图识别时参考的最近消息条数（含用户的最新消息）
const ROUTER_CONTEXT_SIZE = 6

// 最多保留几个步骤、每个步骤最多多少字
const MAX_STEPS = 8
const STEP_LENGTH = 100

function parseFlag(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return undefined
}

/** 字符串数组：去掉空白与重复；不是数组时为空 */
function parseStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const items = value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
  return [...new Set(items)]
}

/**
 * 从 LLM 的输出中解析意图识别结果（是闲聊还是任务）。兼容代码块包裹、前后夹带说明文字、布尔值写成字符串等情况。
 * 无法解析或没有给出 task 时以 fallback 为准：判断用户的消息时宁可当成任务（执行模块还会再判断一次），
 * 判断图片中的要求时宁可不执行
 */
export function parseRouteDecision(text: string, fallback: boolean): RouteDecision {
  const data = parseJsonObject(text)
  const task = parseFlag(data?.task)
  if (task === undefined) return { task: fallback, reason: '无法解析意图识别结果' }
  if (!task) return { task, reason: typeof data?.reason === 'string' ? data.reason : '' }
  const steps = parseStrings(data?.steps).slice(0, MAX_STEPS).map((step) => step.slice(0, STEP_LENGTH))
  const skills = parseStrings(data?.skills)
  return {
    task,
    reason: typeof data?.reason === 'string' ? data.reason : '',
    // 需要较多步骤的任务允许更多轮的工具调用；只有明确为 true 时才算
    ...(parseFlag(data?.complex) ? { complex: true } : {}),
    ...(steps.length ? { steps } : {}),
    ...(skills.length ? { skills } : {}),
  }
}

interface RouterOptions {
  /** 意图识别使用的模型，建议用便宜快速的小模型 */
  model: LanguageModel
  messages: ModelMessage[]
  skills: Skill[]
  abortSignal?: AbortSignal
}

/** 阶段一：意图识别。只判断用户的最新消息是普通闲聊，还是需要借助技能完成的任务 */
export async function routeIntent(options: RouterOptions): Promise<RouteDecision> {
  const { model, messages, skills, abortSignal } = options
  if (skills.length === 0) return { task: false, reason: '没有可用的技能' }

  const { text } = await generateText({
    model,
    system: buildRouterSystemPrompt(skills),
    prompt: buildRouterPrompt(recentMessages(messages, ROUTER_CONTEXT_SIZE)),
    temperature: 0,
    abortSignal,
  })
  return parseRouteDecision(text, true)
}

/**
 * 读出用户发来的图片之后再判断一次：意图识别时看不到图片，用户把要求写在图片里时（如截图发来一段需求），
 * 读出图片后才知道要做什么。只是想看懂图片、或者图中的指令不是写给桌宠的时候不是任务
 */
export async function routeImageRequest(options: RouterOptions, imageContent: string): Promise<RouteDecision> {
  const { model, messages, skills, abortSignal } = options
  if (skills.length === 0) return { task: false, reason: '没有可用的技能' }

  const { text } = await generateText({
    model,
    system: buildImageRequestSystemPrompt(skills),
    prompt: buildImageRequestPrompt(recentMessages(messages, ROUTER_CONTEXT_SIZE), imageContent),
    temperature: 0,
    abortSignal,
  })
  return parseRouteDecision(text, false)
}
