import type { ActivityEvent, ActivityState } from '@/proactive/activity'
import type { ProactiveSettings, ProactiveState, TriggerId } from '@/proactive/types'
import type { Task } from '@/tasks/model'
import { truncate } from '@/agent/utils'
import { APP_CATEGORY_LABELS } from '@/proactive/activity'
import { triggerInfo, TRIGGERS } from '@/proactive/types'
import { startOfDay } from '@/tasks/model'

/**
 * 主动交互的时机：
 * - 时间：每日问候、节日问候、饭点、下午茶、周末、深夜；
 * - 上下文：长时间专注、久坐、待办快到期；
 * - 事件：回到电脑前、切换应用、结束全屏、开完会；
 * - 自发：小动作、做个动作、自言自语、主动聊天、分享小发现。
 * 这里只判断「时机到了没有」，能不能打扰由 gate 判断。
 */

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

/** 一天从凌晨 5 点开始算：深夜 1 点仍然算前一天，避免同一个夜里提醒两次 */
export const DAY_START_HOUR = 5

/** 一次主动交互的时机 */
export interface ProactiveCandidate {
  trigger: TriggerId
  /** 给模型看的情况说明，如「用户已经连续编程 1 小时 40 分钟」 */
  situation: string
  /** 每天最多一次 */
  daily?: boolean
  /** 处理后，这些每日时机今天也算处理过（如节日问候与每日问候合成一句） */
  alsoHandles?: TriggerId[]
  /** 冷却：同一个键在冷却时间内不再出现；有多个键时，其中任何一个在冷却中都不出现 */
  cooldown?: { key: string | string[], ms: number }
  /** 长时间专注：处理后记下这段专注已经提醒过几次 */
  focus?: { since: number, count: number }
  /** 提醒休息（长时间专注、久坐）：处理后记下时间，两种提醒不会挨得太近 */
  rest?: boolean
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 以凌晨 5 点为一天的开始，返回 YYYY-MM-DD */
export function dayKey(now: number): string {
  return dateKey(new Date(now - DAY_START_HOUR * 60 * MINUTE))
}

/** 解析 HH:mm，返回当天的第几分钟；格式不对时返回 null */
export function parseTime(text: string): number | null {
  const match = text.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

export function minutesOfDay(now: number): number {
  const date = new Date(now)
  return date.getHours() * 60 + date.getMinutes()
}

/** 现在是否在从 start 开始、持续 duration 分钟的时间窗口内（可以跨过午夜） */
export function inWindow(now: number, start: number, duration: number): boolean {
  return (minutesOfDay(now) - start + 1440) % 1440 < duration
}

/** 现在是否在安静时段内（开始时间晚于结束时间时跨过午夜，如 23:00 ~ 07:00） */
export function inQuietHours(now: number, quietHours: ProactiveSettings['quietHours']): boolean {
  if (!quietHours.enabled) return false
  const start = parseTime(quietHours.start)
  const end = parseTime(quietHours.end)
  if (start === null || end === null || start === end) return false
  return inWindow(now, start, (end - start + 1440) % 1440)
}

export function formatClock(now: number): string {
  const date = new Date(now)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 「1 小时 40 分钟」「25 分钟」 */
export function formatMinutes(ms: number): string {
  const total = Math.max(1, Math.round(ms / MINUTE))
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  if (!hours) return `${minutes} 分钟`
  return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`
}

/** 一天中的时段，如「上午」「深夜」 */
export function periodOfDay(now: number): string {
  const hour = new Date(now).getHours()
  if (hour < 5) return '凌晨'
  if (hour < 9) return '早上'
  if (hour < 11) return '上午'
  if (hour < 13) return '中午'
  if (hour < 17) return '下午'
  if (hour < 19) return '傍晚'
  if (hour < 23) return '晚上'
  return '深夜'
}

// 农历：用浏览器自带的农历历法换算；当前环境不支持时只看公历节日
const lunarFormat = (() => {
  try {
    const format = new Intl.DateTimeFormat('en-US-u-ca-chinese', { month: 'numeric', day: 'numeric' })
    return format.resolvedOptions().calendar === 'chinese' ? format : null
  }
  catch {
    return null
  }
})()

/** 农历的月、日；闰月（如闰六月会格式化成 6bis）时 leap 为 true。不支持农历时返回 null */
export function lunarDate(time: number): { month: number, day: number, leap: boolean } | null {
  if (!lunarFormat) return null
  const parts = lunarFormat.formatToParts(new Date(time))
  const month = parts.find((part) => part.type === 'month')?.value ?? ''
  const monthNumber = Number.parseInt(month, 10)
  const day = Number(parts.find((part) => part.type === 'day')?.value)
  if (!Number.isInteger(monthNumber) || !Number.isInteger(day)) return null
  return { month: monthNumber, day, leap: !/^\d+$/.test(month) }
}

const SOLAR_FESTIVALS: Record<string, string> = {
  '1-1': '元旦',
  '2-14': '情人节',
  '5-1': '劳动节',
  '6-1': '儿童节',
  '10-1': '国庆节',
  '12-24': '平安夜',
  '12-25': '圣诞节',
}

const LUNAR_FESTIVALS: Record<string, string> = {
  '1-1': '春节',
  '1-15': '元宵节',
  '5-5': '端午节',
  '7-7': '七夕',
  '8-15': '中秋节',
  '9-9': '重阳节',
  '12-8': '腊八节',
}

/** 今天（按 0 点分日）是什么节日，如「中秋节」「中秋节、国庆节」；不是节日时返回 null */
export function festivalOf(now: number): string | null {
  const date = new Date(now)
  const names: string[] = []
  const lunar = lunarDate(now)
  const lunarFestival = lunar && !lunar.leap ? LUNAR_FESTIVALS[`${lunar.month}-${lunar.day}`] : undefined
  if (lunarFestival) names.push(lunarFestival)
  // 除夕是农历新年的前一天（腊月有时只有二十九天，不能只看腊月三十）
  const tomorrow = lunarDate(new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 12).getTime())
  if (tomorrow && !tomorrow.leap && tomorrow.month === 1 && tomorrow.day === 1) names.push('除夕')
  const solarFestival = SOLAR_FESTIVALS[`${date.getMonth() + 1}-${date.getDate()}`]
  if (solarFestival) names.push(solarFestival)
  return names.length ? names.join('、') : null
}

// 饭点提醒的时间窗口：设定时间前 15 分钟到之后 75 分钟
const MEAL_BEFORE = 15
const MEAL_DURATION = 90
// 下午茶的时间窗口：设定时间之后 90 分钟内
const AFTERNOON_BREAK_DURATION = 90
// 周末问候：周五 17:00 之后的 6 小时内
const WEEKEND_START = 17 * 60
const WEEKEND_DURATION = 6 * 60
// 深夜提醒的时间窗口：设定时间之后 150 分钟内
const LATE_NIGHT_DURATION = 150

/**
 * 时间驱动的时机：在各自的时间窗口内、今天还没处理过时出现。
 * 被拦下（如正在全屏看视频）时不算处理过，窗口内下次再试
 */
export function timeCandidates(now: number, settings: ProactiveSettings, state: ProactiveState, activity: ActivityState | null): ProactiveCandidate[] {
  const candidates: ProactiveCandidate[] = []
  const handled = (id: TriggerId) => state.handledToday.includes(id)
  const present = activity?.present ?? true
  const greeted = handled('daily-greeting')
  const firstSeen = `今天第一次见到用户（${periodOfDay(now)} ${formatClock(now)}）`

  // 节日问候排在每日问候前面：当天第一次见面时合成一句；节日问候关闭或被拦下时，每日问候照常进行。
  // 同一个节日只问候一次（凌晨问候过春节，早上 5 点算新的一天后也不会再问候）
  const festival = festivalOf(now)
  if (festival && !handled('festival') && present) {
    candidates.push({
      trigger: 'festival',
      situation: greeted ? `今天是${festival}` : `今天是${festival}；${firstSeen}`,
      daily: true,
      alsoHandles: greeted ? [] : ['daily-greeting'],
      cooldown: { key: `festival:${dateKey(new Date(now))}`, ms: DAY },
    })
  }

  if (!greeted && present) {
    candidates.push({ trigger: 'daily-greeting', situation: firstSeen, daily: true })
  }

  for (const [id, time, label] of [['lunch', settings.lunchTime, '午饭'], ['dinner', settings.dinnerTime, '晚饭']] as const) {
    const start = parseTime(time)
    if (start === null || handled(id)) continue
    if (inWindow(now, (start - MEAL_BEFORE + 1440) % 1440, MEAL_DURATION)) {
      candidates.push({ trigger: id, situation: `到${label}时间了（现在 ${formatClock(now)}）`, daily: true })
    }
  }

  const afternoonBreak = parseTime(settings.afternoonBreakTime)
  if (afternoonBreak !== null && !handled('afternoon-break') && inWindow(now, afternoonBreak, AFTERNOON_BREAK_DURATION)) {
    candidates.push({ trigger: 'afternoon-break', situation: `${periodOfDay(now)} ${formatClock(now)} 了，正是容易犯困的时候`, daily: true })
  }

  if (new Date(now).getDay() === 5 && !handled('weekend') && inWindow(now, WEEKEND_START, WEEKEND_DURATION)) {
    candidates.push({ trigger: 'weekend', situation: `今天是周五，这周快结束了（现在 ${formatClock(now)}）`, daily: true })
  }

  const lateNight = parseTime(settings.lateNightTime)
  // 只在确实知道用户还在用电脑时提醒
  if (lateNight !== null && !handled('late-night') && activity?.available && present && inWindow(now, lateNight, LATE_NIGHT_DURATION)) {
    candidates.push({ trigger: 'late-night', situation: `已经 ${formatClock(now)} 了，用户还在用电脑`, daily: true })
  }
  return candidates
}

/**
 * 上下文驱动：在同一类应用中连续专注了设定的时间；之后每再专注这么久提醒一次。
 * 刚提醒过休息（如久坐提醒）时，等隔够这么久再提醒
 */
export function focusCandidate(now: number, settings: ProactiveSettings, state: ProactiveState, activity: ActivityState | null): ProactiveCandidate | null {
  const focus = activity?.focus
  if (!focus || !activity.present || settings.focusMinutes <= 0) return null
  if (now - state.lastRestReminderAt < settings.focusMinutes * MINUTE) return null
  const count = state.focusNotified?.since === focus.since ? state.focusNotified.count : 0
  const elapsed = now - focus.since
  if (elapsed < settings.focusMinutes * MINUTE * (count + 1)) return null
  return {
    trigger: 'long-focus',
    situation: `用户已经连续${APP_CATEGORY_LABELS[focus.category]} ${formatMinutes(elapsed)}${count ? `（之前已经提醒过 ${count} 次）` : ''}`,
    focus: { since: focus.since, count: count + 1 },
    rest: true,
  }
}

/**
 * 上下文驱动：连续在电脑前（中途没有离开）设定的时间，不管在用什么应用。
 * 和上一次提醒休息（包括长时间专注的提醒）也要隔这么久，避免两种提醒挨在一起
 */
export function sedentaryCandidate(now: number, settings: ProactiveSettings, state: ProactiveState, activity: ActivityState | null): ProactiveCandidate | null {
  const since = activity?.present ? activity.presentSince : null
  if (since === null || since === undefined || settings.sedentaryMinutes <= 0) return null
  if (now - Math.max(since, state.lastRestReminderAt) < settings.sedentaryMinutes * MINUTE) return null
  const reminded = state.lastRestReminderAt > since ? `（${formatMinutes(now - state.lastRestReminderAt)}前提醒过休息）` : ''
  return {
    trigger: 'sedentary',
    situation: `用户已经在电脑前连续坐了 ${formatMinutes(now - since)}，中途没有离开过${reminded}`,
    rest: true,
  }
}

/** 待办中用到的字段 */
export type TaskBrief = Pick<Task, 'id' | 'title' | 'due' | 'dueHasTime' | 'remindAt' | 'done'>

// 带具体时刻的待办，到期前多久提醒；只有日期的待办，当天几点之后提醒
const TASK_DUE_AHEAD = 60 * MINUTE
const TASK_DATE_ONLY_FROM = 16 * 60
// 一次最多提几个待办
const TASK_DUE_LIMIT = 3

const taskCooldownKey = (task: TaskBrief) => `task-due:${task.id}`

function describeTaskDue(task: TaskBrief, now: number): string {
  if (!task.dueHasTime || task.due === undefined) return '今天到期'
  if (task.due >= now) return `${formatClock(task.due)} 到期（还有 ${formatMinutes(task.due - now)}）`
  return `${formatClock(task.due)} 到期，已经过了 ${formatMinutes(now - task.due)}`
}

/**
 * 上下文驱动：一小时内到期（只有日期的，当天下午 4 点之后）、还没完成的待办。
 * 设置了提醒时间的待办由提醒功能负责；每个待办只提一次（冷却一天，过了这天也就不再符合条件）
 */
export function taskDueCandidate(now: number, state: ProactiveState, tasks: readonly TaskBrief[]): ProactiveCandidate | null {
  const today = startOfDay(now)
  const due = tasks
    .filter((task): task is TaskBrief & { due: number } => {
      if (task.done || task.due === undefined || task.remindAt !== undefined) return false
      if ((state.cooldowns[taskCooldownKey(task)] ?? 0) > now) return false
      if (task.dueHasTime) return task.due >= today && task.due <= now + TASK_DUE_AHEAD
      return startOfDay(task.due) === today && minutesOfDay(now) >= TASK_DATE_ONLY_FROM
    })
    .sort((a, b) => a.due - b.due)
  if (due.length === 0) return null

  const listed = due.slice(0, TASK_DUE_LIMIT)
  const items = listed.map((task) => `「${truncate(task.title, 40)}」${describeTaskDue(task, now)}`).join('；')
  const more = due.length > listed.length ? `；另外还有 ${due.length - listed.length} 个` : ''
  return {
    trigger: 'task-due',
    situation: `有待办快到期了还没完成：${items}${more}`,
    cooldown: { key: listed.map(taskCooldownKey), ms: DAY },
  }
}

// 事件驱动的时机的冷却时间
const IDLE_RETURN_COOLDOWN = 60 * MINUTE
const APP_SWITCH_COOLDOWN = 30 * MINUTE
const FULLSCREEN_EXIT_COOLDOWN = 60 * MINUTE
const MEETING_END_COOLDOWN = 30 * MINUTE
// 会议用了多久之后离开，才算开完了一个会
const MEETING_MIN_MS = 10 * MINUTE

/**
 * 事件驱动：活动状态变化产生的事件。一个事件可能对应多个时机，按顺序尝试：
 * 前面的被拦下（如开完会的时机关闭了）时再试后面的
 */
export function eventCandidates(event: ActivityEvent): ProactiveCandidate[] {
  if (event.type === 'idle-return') {
    return [{
      trigger: 'idle-return',
      situation: `用户离开电脑 ${formatMinutes(event.awayMs)}后刚回来`,
      cooldown: { key: 'idle-return', ms: IDLE_RETURN_COOLDOWN },
    }]
  }
  if (event.type === 'fullscreen-exit') {
    return [{
      trigger: 'fullscreen-exit',
      situation: `用户刚退出全屏，之前全屏${APP_CATEGORY_LABELS[event.category]} ${formatMinutes(event.durationMs)}（${event.app}）`,
      cooldown: { key: 'fullscreen-exit', ms: FULLSCREEN_EXIT_COOLDOWN },
    }]
  }

  const appSwitch: ProactiveCandidate = {
    trigger: 'app-switch',
    situation: `用户刚从${APP_CATEGORY_LABELS[event.from]}换成了${APP_CATEGORY_LABELS[event.to]}（${event.app}）`,
    cooldown: { key: 'app-switch', ms: APP_SWITCH_COOLDOWN },
  }
  if (event.from !== 'meeting' || event.fromMs < MEETING_MIN_MS) return [appSwitch]
  return [{
    trigger: 'meeting-end',
    situation: `用户刚离开会议（在 ${event.fromApp} 中开了约 ${formatMinutes(event.fromMs)}），现在在${APP_CATEGORY_LABELS[event.to]}（${event.app}）`,
    cooldown: { key: 'meeting-end', ms: MEETING_END_COOLDOWN },
  }, appSwitch]
}

/** 自发交互平均多久出现一次（说话的还会乘以频率设置的倍数） */
export const SPONTANEOUS_MEAN_MS: Partial<Record<TriggerId, number>> = {
  'idle-animation': 4 * MINUTE,
  'random-motion': 15 * MINUTE,
  'self-talk': 60 * MINUTE,
  'topic': 90 * MINUTE,
  'share': 120 * MINUTE,
}

const SPONTANEOUS_SITUATIONS: Partial<Record<TriggerId, string>> = {
  'idle-animation': '随便做个小动作',
  'random-motion': '随便做个动作',
  'self-talk': '有一会儿没说话了，可以自言自语一句',
  'topic': '有一会儿没聊天了，可以主动找用户聊聊',
  'share': '有一会儿没说话了，可以分享一个有趣的小发现',
}

/**
 * 自发交互：按平均间隔随机出现。elapsedMs 为距离上次检查的时间，
 * 出现的概率为 elapsedMs / 平均间隔，因此检查的频率不影响平均间隔
 */
export function spontaneousCandidates(random: () => number, elapsedMs: number, scale: number): ProactiveCandidate[] {
  return TRIGGERS.filter((trigger) => trigger.group === 'spontaneous').flatMap((trigger): ProactiveCandidate[] => {
    const mean = SPONTANEOUS_MEAN_MS[trigger.id]
    if (!mean) return []
    const probability = elapsedMs / mean * (triggerInfo(trigger.id).kind === 'speech' ? scale : 1)
    return random() < probability ? [{ trigger: trigger.id, situation: SPONTANEOUS_SITUATIONS[trigger.id] ?? '' }] : []
  })
}
