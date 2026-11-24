import type { ActivityState } from '@/proactive/activity'
import type { ProactiveSettings, ProactiveState, TriggerInfo } from '@/proactive/types'
import { formatMinutes, inQuietHours } from '@/proactive/triggers'
import { FREQUENCY_PRESETS } from '@/proactive/types'

/**
 * 本地筛选：在调用模型之前，按规则拦下明显不该打扰的时机（不花钱、不耗时）。
 * 按顺序检查，第一条不满足的规则就是被拦下的原因，会写进主动交互的记录里。
 */

const MINUTE = 60_000

/** 用户刚发过消息多久内不主动开口（正在聊天时不需要主动找话题） */
export const RECENT_CHAT_MS = 3 * MINUTE
/** 连续被忽略时，间隔最多拉长到几倍 */
const MAX_BACKOFF = 8
const PRIORITY_SCALE: Record<TriggerInfo['priority'], number> = { high: 0.5, normal: 1, low: 1.5 }

export interface ConversationState {
  /** 正在生成回复、等待授权或等待用户回答问题 */
  busy: boolean
  /** 用户最近一次发消息的时间 */
  lastUserMessageAt: number
}

export interface GateContext {
  now: number
  settings: ProactiveSettings
  state: ProactiveState
  /** 用户的活动状态；还没有获取到时为空 */
  activity: ActivityState | null
  conversation: ConversationState
  /** 手动「试一下」：跳过时机开关、安静时段与频率限制，但仍然遵守免打扰与不打断 */
  force?: boolean
}

export type GateResult = { ok: true } | { ok: false, reason: string }

/** 连续被忽略几次后，最短间隔的倍数：1、2、4、8 */
export function backoffScale(ignoredStreak: number): number {
  return Math.min(2 ** Math.max(0, ignoredStreak), MAX_BACKOFF)
}

/** 这个时机与上次主动说话之间至少要隔多久 */
export function minInterval(trigger: TriggerInfo, settings: ProactiveSettings, state: ProactiveState): number {
  return FREQUENCY_PRESETS[settings.frequency].minIntervalMs * PRIORITY_SCALE[trigger.priority] * backoffScale(state.ignoredStreak)
}

export function checkGate(trigger: TriggerInfo, context: GateContext): GateResult {
  const { now, settings, state, activity, conversation, force } = context
  const block = (reason: string): GateResult => ({ ok: false, reason })

  if (!settings.enabled) return block('主动交互已关闭')
  if (!force && !settings.triggers[trigger.id]) return block('这个时机已关闭')
  if (settings.dndUntil > now) return block('免打扰中')
  if (conversation.busy) return block('正在对话或者执行任务')
  if (!force && inQuietHours(now, settings.quietHours)) return block('安静时段')

  if (activity) {
    // 回到电脑前的时机本身就发生在用户回来的那一刻
    if (!activity.present && trigger.id !== 'idle-return') return block('用户不在电脑前')
    if (activity.fullscreen && settings.respectFullscreen) return block('用户正在全屏使用（游戏、视频或演示）')
    if (activity.category === 'meeting') return block('用户可能在开会')
  }

  if (trigger.kind === 'animation') return { ok: true }

  if (now - conversation.lastUserMessageAt < RECENT_CHAT_MS) return block('刚刚聊过天')
  if (!force) {
    const preset = FREQUENCY_PRESETS[settings.frequency]
    if (state.spokenToday >= preset.dailyLimit) return block(`今天已经主动说了 ${state.spokenToday} 次，到上限了`)
    const interval = minInterval(trigger, settings, state)
    if (now - state.lastSpokeAt < interval) {
      const backoff = state.ignoredStreak > 0 ? `（最近 ${state.ignoredStreak} 次没有得到回应，间隔拉长了）` : ''
      return block(`距离上次主动说话还不到 ${formatMinutes(interval)}${backoff}`)
    }
  }
  return { ok: true }
}
