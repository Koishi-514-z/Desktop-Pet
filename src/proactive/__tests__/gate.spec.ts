import type { ActivityState } from '@/proactive/activity'
import type { GateContext } from '@/proactive/gate'
import type { ProactiveSettings, ProactiveState } from '@/proactive/types'
import { describe, expect, it } from 'vitest'
import { checkGate } from '@/proactive/gate'
import { createState, mergeSettings, triggerInfo } from '@/proactive/types'

const MINUTE = 60_000
const NOW = new Date(2026, 10, 24, 15, 0).getTime()

function context(overrides: {
  settings?: Partial<ProactiveSettings>
  state?: Partial<ProactiveState>
  activity?: Partial<ActivityState> | null
  busy?: boolean
  lastUserMessageAt?: number
  force?: boolean
} = {}): GateContext {
  const activity: ActivityState | null = overrides.activity === null
    ? null
    : { available: true, present: true, presentSince: null, idleSeconds: 0, app: 'Code', category: 'coding', title: '', appSince: null, fullscreen: false, focus: null, ...overrides.activity }
  return {
    now: NOW,
    settings: mergeSettings(overrides.settings ?? {}),
    state: { ...createState(), ...overrides.state },
    activity,
    conversation: { busy: overrides.busy ?? false, lastUserMessageAt: overrides.lastUserMessageAt ?? 0 },
    force: overrides.force,
  }
}

const topic = triggerInfo('topic')
const reason = (result: ReturnType<typeof checkGate>) => (result.ok ? 'ok' : result.reason)

describe('本地筛选', () => {
  it('没有限制时通过', () => {
    expect(checkGate(topic, context())).toEqual({ ok: true })
  })

  it('关闭、免打扰、正在对话时拦下；免打扰时「试一下」也不行', () => {
    expect(reason(checkGate(topic, context({ settings: { enabled: false } })))).toBe('主动交互已关闭')
    expect(reason(checkGate(topic, context({ settings: { dndUntil: NOW + MINUTE } })))).toBe('免打扰中')
    expect(reason(checkGate(topic, context({ settings: { dndUntil: NOW + MINUTE }, force: true })))).toBe('免打扰中')
    expect(reason(checkGate(topic, context({ busy: true })))).toBe('正在对话或者执行任务')
  })

  it('时机关闭或者在安静时段时拦下，「试一下」可以跳过', () => {
    const closed = { triggers: { ...mergeSettings({}).triggers, topic: false } }
    expect(reason(checkGate(topic, context({ settings: closed })))).toBe('这个时机已关闭')
    expect(checkGate(topic, context({ settings: closed, force: true }))).toEqual({ ok: true })
    const quiet = { quietHours: { enabled: true, start: '14:00', end: '16:00' } }
    expect(reason(checkGate(topic, context({ settings: quiet })))).toBe('安静时段')
    expect(checkGate(topic, context({ settings: quiet, force: true }))).toEqual({ ok: true })
  })

  it('用户不在电脑前、全屏、开会时不打扰；回到电脑前的时机不受「不在电脑前」限制', () => {
    expect(reason(checkGate(topic, context({ activity: { present: false } })))).toBe('用户不在电脑前')
    expect(checkGate(triggerInfo('idle-return'), context({ activity: { present: false } }))).toEqual({ ok: true })
    expect(reason(checkGate(topic, context({ activity: { fullscreen: true } })))).toBe('用户正在全屏使用（游戏、视频或演示）')
    expect(checkGate(topic, context({ activity: { fullscreen: true }, settings: { respectFullscreen: false } }))).toEqual({ ok: true })
    expect(reason(checkGate(topic, context({ activity: { category: 'meeting' } })))).toBe('用户可能在开会')
    // 还没有获取到活动状态时不限制
    expect(checkGate(topic, context({ activity: null }))).toEqual({ ok: true })
  })

  it('刚聊过天时不主动说话，但可以做小动作', () => {
    expect(reason(checkGate(topic, context({ lastUserMessageAt: NOW - MINUTE })))).toBe('刚刚聊过天')
    expect(checkGate(triggerInfo('idle-animation'), context({ lastUserMessageAt: NOW - MINUTE }))).toEqual({ ok: true })
  })

  it('两次主动说话之间的间隔：优先级高的短一些，连续被忽略时拉长', () => {
    const spoke = (minutesAgo: number, ignoredStreak = 0) => context({ state: { lastSpokeAt: NOW - minutesAgo * MINUTE, ignoredStreak } })
    // 适中：30 分钟；主动聊天优先级低，45 分钟
    expect(reason(checkGate(topic, spoke(40)))).toBe('距离上次主动说话还不到 45 分钟')
    expect(checkGate(topic, spoke(50))).toEqual({ ok: true })
    // 提醒吃饭优先级高，15 分钟
    expect(checkGate(triggerInfo('lunch'), spoke(20))).toEqual({ ok: true })
    // 连续 2 次没有回应：间隔变成 4 倍
    expect(reason(checkGate(triggerInfo('lunch'), spoke(20, 2)))).toBe('距离上次主动说话还不到 1 小时（最近 2 次没有得到回应，间隔拉长了）')
    expect(checkGate(topic, { ...spoke(1), force: true })).toEqual({ ok: true })
  })

  it('每天的次数有上限', () => {
    expect(reason(checkGate(topic, context({ state: { spokenToday: 12 } })))).toBe('今天已经主动说了 12 次，到上限了')
    expect(checkGate(topic, context({ state: { spokenToday: 12 }, settings: { frequency: 'high' } }))).toEqual({ ok: true })
  })
})
