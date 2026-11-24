import type { LanguageModel } from 'ai'
import type { ActivityState } from '@/proactive/activity'
import type { ProactiveState, TriggerInfo } from '@/proactive/types'
import { generateText } from 'ai'
import { getWeekday, parseJsonObject, truncate } from '@/agent/utils'
import { APP_CATEGORY_LABELS } from '@/proactive/activity'
import { formatClock, formatMinutes, periodOfDay } from '@/proactive/triggers'

/**
 * 模型判断：本地筛选通过后，由小模型（意图识别使用的模型）判断现在要不要说、打算说什么、需要查哪些信息。
 * 判断不了（输出无法解析）时不说：主动交互宁可少打扰。
 */

export interface DialogLine {
  role: 'user' | 'assistant'
  content: string
}

export interface ContextInput {
  now: number
  activity: ActivityState | null
  /** 是否把窗口标题告诉模型 */
  shareWindowTitle: boolean
  state: ProactiveState
  assistantName: string
  /** 最近的几条对话；生成时对话已经在消息中了，不必再附上 */
  recentDialog?: DialogLine[]
}

// 情况说明中最近的对话保留的条数与每条的长度
const DIALOG_LINES = 4
const DIALOG_LENGTH = 100
const TITLE_LENGTH = 80

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 整理成给模型看的「当前情况」 */
export function describeContext(input: ContextInput): string {
  const { now, activity, shareWindowTitle, state, assistantName, recentDialog = [] } = input
  const date = new Date(now)
  const lines = [`- 现在：${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${formatClock(now)} ${getWeekday(date)}（${periodOfDay(now)}）`]

  if (!activity?.available) {
    lines.push('- 用户在做什么：不知道（无法获取前台应用）')
  }
  else if (!activity.present) {
    lines.push(`- 用户已经 ${formatMinutes(activity.idleSeconds * 1000)}没有操作电脑了`)
  }
  else if (activity.app && activity.category) {
    const label = APP_CATEGORY_LABELS[activity.category]
    const using = activity.appSince ? `，已经用了 ${formatMinutes(now - activity.appSince)}` : ''
    const focus = activity.focus?.category === activity.category ? `，连续${label} ${formatMinutes(now - activity.focus.since)}` : ''
    lines.push(`- 用户正在${label}（${activity.app}）${using}${focus}`)
    if (shareWindowTitle && activity.title.trim()) lines.push(`- 窗口标题：${truncate(activity.title.trim(), TITLE_LENGTH)}`)
  }

  const last = state.recentLines.at(-1)
  lines.push(`- 今天已经主动说话 ${state.spokenToday} 次${last ? `，最近一次在 ${formatClock(last.at)}：「${truncate(last.text, DIALOG_LENGTH)}」` : ''}`)
  if (state.ignoredStreak > 0) lines.push(`- 最近 ${state.ignoredStreak} 次主动说话，用户都没有回应`)

  const dialog = recentDialog.slice(-DIALOG_LINES)
  if (dialog.length) {
    lines.push('- 最近的对话：')
    for (const line of dialog) lines.push(`  ${line.role === 'user' ? '用户' : assistantName}：${truncate(line.content.replace(/\s+/g, ' '), DIALOG_LENGTH)}`)
  }
  return lines.join('\n')
}

export interface ProactiveDecision {
  speak: boolean
  reason: string
  /** 打算说什么，一句话 */
  intent: string
  /** 需要用来获取信息的技能 id */
  skills: string[]
}

export interface SkillBrief {
  id: string
  name: string
  description: string
}

export function buildJudgeSystemPrompt(assistantName: string, skills: SkillBrief[]): string {
  const skillLines = skills.length
    ? skills.map((skill) => `  - ${skill.id}（${skill.name}）：${truncate(skill.description, 80)}`).join('\n')
    : '  （没有可用的技能）'
  return `你是桌宠「${assistantName}」的主动交互模块。程序发现了一个可能适合主动和用户说话的时机，由你判断现在要不要说、打算说什么。你的输出只给程序读取，不会展示给用户。

# 判断原则
- 主动说话要值得这次打扰：能帮上忙（提醒吃饭、休息、天气变化、快到期的待办）、能让用户开心、或者是自然的问候时才说；用户在专注工作时，除非很有必要，不要打扰。
- 不要重复：今天已经说过的话题、问候过的事不要再说一遍。
- 最近用户没有回应时更克制一些，可以不说。
- 想说的内容需要实时信息时，在 skills 中列出要用的技能（只能读取信息，不会修改任何东西），不需要时为空数组。例如提醒吃饭时可以顺便看看天气，主动聊天时可以翻翻记得的事：
${skillLines}

# 输出格式
只输出一个 JSON 对象，不要输出任何其他内容：
{"speak": true, "reason": "一句话理由", "intent": "打算说什么，一句话", "skills": []}
不说时：{"speak": false, "reason": "一句话理由", "intent": "", "skills": []}`
}

export function buildJudgePrompt(trigger: TriggerInfo, situation: string, context: string): string {
  return `# 时机
${trigger.label}：${situation}

# 当前情况
${context}`
}

function parseFlag(value: unknown): boolean {
  return value === true || value === 'true'
}

/** 解析判断结果；无法解析时不说，只能使用提供的技能 */
export function parseDecision(text: string, allowedSkills: string[]): ProactiveDecision {
  const data = parseJsonObject(text)
  if (!data) return { speak: false, reason: '无法解析判断结果', intent: '', skills: [] }
  const skills = Array.isArray(data.skills) ? data.skills.filter((id): id is string => typeof id === 'string' && allowedSkills.includes(id)) : []
  return {
    speak: parseFlag(data.speak),
    reason: typeof data.reason === 'string' ? data.reason : '',
    intent: typeof data.intent === 'string' ? data.intent.trim() : '',
    skills: [...new Set(skills)],
  }
}

export async function judgeProactive(options: {
  model: LanguageModel
  assistantName: string
  trigger: TriggerInfo
  situation: string
  context: string
  skills: SkillBrief[]
  abortSignal?: AbortSignal
}): Promise<ProactiveDecision> {
  const { model, assistantName, trigger, situation, context, skills, abortSignal } = options
  const { text } = await generateText({
    model,
    system: buildJudgeSystemPrompt(assistantName, skills),
    prompt: buildJudgePrompt(trigger, situation, context),
    temperature: 0,
    abortSignal,
  })
  return parseDecision(text, skills.map((skill) => skill.id))
}

/** 决定说话后，交给角色扮演阶段的事件说明（以隐藏的系统通知加入对话） */
export function buildSpeakEvent(trigger: TriggerInfo, situation: string, intent: string, context: string): string {
  return `这是一次主动交互（${trigger.label}）：${situation}。
你打算：${intent || '自然地说一句'}
当前情况：
${context}
要求：像熟悉的朋友一样自然地主动开口，一两句话就好，不要说教，也不要每次都用同样的开头；用户可能正在忙，不必追问，也不要求回复。${trigger.guidance ? `\n${trigger.guidance}` : ''}`
}
