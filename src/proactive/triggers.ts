import type { ActivityEvent, ActivityState } from '@/proactive/activity'
import type { ProactiveSettings, ProactiveState, TriggerId } from '@/proactive/types'
import { APP_CATEGORY_LABELS } from '@/proactive/activity'
import { triggerInfo, TRIGGERS } from '@/proactive/types'

/**
 * 主动交互的时机：时间（每日问候、饭点、深夜）、上下文（长时间专注）、事件（回到电脑前、切换应用）、
 * 自发（小动作、自言自语、主动聊天）。这里只判断「时机到了没有」，能不能打扰由 gate 判断。
 */

const MINUTE = 60_000

/** 一天从凌晨 5 点开始算：深夜 1 点仍然算前一天，避免同一个夜里提醒两次 */
export const DAY_START_HOUR = 5

/** 一次主动交互的时机 */
export interface ProactiveCandidate {
  trigger: TriggerId
  /** 给模型看的情况说明，如「用户已经连续编程 1 小时 40 分钟」 */
  situation: string
  /** 每天最多一次 */
  daily?: boolean
  /** 冷却：同一个键在冷却时间内不再出现 */
  cooldown?: { key: string, ms: number }
  /** 长时间专注：处理后记下这段专注已经提醒过几次 */
  focus?: { since: number, count: number }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 以凌晨 5 点为一天的开始，返回 YYYY-MM-DD */
export function dayKey(now: number): string {
  const date = new Date(now - DAY_START_HOUR * 60 * MINUTE)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
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

// 饭点提醒的时间窗口：设定时间前 15 分钟到之后 75 分钟
const MEAL_BEFORE = 15
const MEAL_DURATION = 90
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

  if (!handled('daily-greeting') && present) {
    candidates.push({ trigger: 'daily-greeting', situation: `今天第一次见到用户（${periodOfDay(now)} ${formatClock(now)}）`, daily: true })
  }

  for (const [id, time, label] of [['lunch', settings.lunchTime, '午饭'], ['dinner', settings.dinnerTime, '晚饭']] as const) {
    const start = parseTime(time)
    if (start === null || handled(id)) continue
    if (inWindow(now, (start - MEAL_BEFORE + 1440) % 1440, MEAL_DURATION)) {
      candidates.push({ trigger: id, situation: `到${label}时间了（现在 ${formatClock(now)}）`, daily: true })
    }
  }

  const lateNight = parseTime(settings.lateNightTime)
  // 只在确实知道用户还在用电脑时提醒
  if (lateNight !== null && !handled('late-night') && activity?.available && present && inWindow(now, lateNight, LATE_NIGHT_DURATION)) {
    candidates.push({ trigger: 'late-night', situation: `已经 ${formatClock(now)} 了，用户还在用电脑`, daily: true })
  }
  return candidates
}

/** 上下文驱动：在同一类应用中连续专注了设定的时间；之后每再专注这么久提醒一次 */
export function focusCandidate(now: number, settings: ProactiveSettings, state: ProactiveState, activity: ActivityState | null): ProactiveCandidate | null {
  const focus = activity?.focus
  if (!focus || !activity.present || settings.focusMinutes <= 0) return null
  const count = state.focusNotified?.since === focus.since ? state.focusNotified.count : 0
  const elapsed = now - focus.since
  if (elapsed < settings.focusMinutes * MINUTE * (count + 1)) return null
  return {
    trigger: 'long-focus',
    situation: `用户已经连续${APP_CATEGORY_LABELS[focus.category]} ${formatMinutes(elapsed)}${count ? `（之前已经提醒过 ${count} 次）` : ''}`,
    focus: { since: focus.since, count: count + 1 },
  }
}

// 事件驱动的时机的冷却时间
const IDLE_RETURN_COOLDOWN = 60 * MINUTE
const APP_SWITCH_COOLDOWN = 30 * MINUTE

/** 事件驱动：活动状态变化产生的事件 */
export function eventCandidate(event: ActivityEvent): ProactiveCandidate {
  if (event.type === 'idle-return') {
    return {
      trigger: 'idle-return',
      situation: `用户离开电脑 ${formatMinutes(event.awayMs)}后刚回来`,
      cooldown: { key: 'idle-return', ms: IDLE_RETURN_COOLDOWN },
    }
  }
  return {
    trigger: 'app-switch',
    situation: `用户刚从${APP_CATEGORY_LABELS[event.from]}换成了${APP_CATEGORY_LABELS[event.to]}（${event.app}）`,
    cooldown: { key: 'app-switch', ms: APP_SWITCH_COOLDOWN },
  }
}

/** 自发交互平均多久出现一次（说话的还会乘以频率设置的倍数） */
export const SPONTANEOUS_MEAN_MS: Partial<Record<TriggerId, number>> = {
  'idle-animation': 4 * MINUTE,
  'self-talk': 60 * MINUTE,
  'topic': 90 * MINUTE,
}

const SPONTANEOUS_SITUATIONS: Partial<Record<TriggerId, string>> = {
  'idle-animation': '随便做个小动作',
  'self-talk': '有一会儿没说话了，可以自言自语一句',
  'topic': '有一会儿没聊天了，可以主动找用户聊聊',
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
