import type { ActivityState } from '@/proactive/activity'
import { describe, expect, it } from 'vitest'
import { dayKey, focusCandidate, formatMinutes, inQuietHours, inWindow, spontaneousCandidates, timeCandidates } from '@/proactive/triggers'
import { createState, DEFAULT_SETTINGS } from '@/proactive/types'

const MINUTE = 60_000
const at = (hours: number, minutes: number, day = 24) => new Date(2026, 10, day, hours, minutes).getTime()

function activity(overrides: Partial<ActivityState> = {}): ActivityState {
  return { available: true, present: true, idleSeconds: 0, app: 'Code', category: 'coding', title: '', appSince: null, fullscreen: false, focus: null, ...overrides }
}

describe('时间', () => {
  it('一天从凌晨 5 点开始算', () => {
    expect(dayKey(at(3, 0, 25))).toBe('2026-11-24')
    expect(dayKey(at(6, 0, 25))).toBe('2026-11-25')
  })

  it('时间窗口与安静时段可以跨过午夜', () => {
    expect(inWindow(at(0, 30), 23 * 60 + 30, 150)).toBe(true)
    expect(inWindow(at(2, 30), 23 * 60 + 30, 150)).toBe(false)
    const quiet = { enabled: true, start: '23:00', end: '07:00' }
    expect(inQuietHours(at(1, 0), quiet)).toBe(true)
    expect(inQuietHours(at(12, 0), quiet)).toBe(false)
    expect(inQuietHours(at(1, 0), { ...quiet, enabled: false })).toBe(false)
  })

  it('时长写成「1 小时 40 分钟」', () => {
    expect(formatMinutes(100 * MINUTE)).toBe('1 小时 40 分钟')
    expect(formatMinutes(60 * MINUTE)).toBe('1 小时')
    expect(formatMinutes(25 * MINUTE)).toBe('25 分钟')
  })
})

describe('时间驱动的时机', () => {
  const state = () => ({ ...createState(), handledToday: ['daily-greeting' as const] })

  it('今天第一次见到用户时问候', () => {
    expect(timeCandidates(at(9, 0), DEFAULT_SETTINGS, createState(), activity()).map((item) => item.trigger)).toEqual(['daily-greeting'])
    expect(timeCandidates(at(9, 0), DEFAULT_SETTINGS, createState(), activity({ present: false }))).toEqual([])
  })

  it('饭点前 15 分钟到之后 75 分钟内提醒，处理过之后今天不再出现', () => {
    expect(timeCandidates(at(11, 40), DEFAULT_SETTINGS, state(), activity())).toEqual([])
    const lunch = timeCandidates(at(12, 10), DEFAULT_SETTINGS, state(), activity())
    expect(lunch).toEqual([{ trigger: 'lunch', situation: '到午饭时间了（现在 12:10）', daily: true }])
    expect(timeCandidates(at(12, 10), DEFAULT_SETTINGS, { ...state(), handledToday: ['daily-greeting', 'lunch'] }, activity())).toEqual([])
    expect(timeCandidates(at(13, 20), DEFAULT_SETTINGS, state(), activity())).toEqual([])
  })

  it('深夜提醒只在确实知道用户还在用电脑时出现', () => {
    expect(timeCandidates(at(23, 40), DEFAULT_SETTINGS, state(), activity()).map((item) => item.trigger)).toEqual(['late-night'])
    expect(timeCandidates(at(23, 40), DEFAULT_SETTINGS, state(), activity({ available: false }))).toEqual([])
    expect(timeCandidates(at(23, 40), DEFAULT_SETTINGS, state(), null)).toEqual([])
  })
})

describe('上下文与自发的时机', () => {
  it('连续专注达到设定的时间时提醒，之后每再专注这么久提醒一次', () => {
    const now = at(15, 0)
    const focused = activity({ focus: { category: 'coding', since: now - 95 * MINUTE } })
    expect(focusCandidate(now, DEFAULT_SETTINGS, createState(), focused)).toEqual({
      trigger: 'long-focus',
      situation: '用户已经连续编程 1 小时 35 分钟',
      focus: { since: now - 95 * MINUTE, count: 1 },
    })
    const notified = { ...createState(), focusNotified: { since: now - 95 * MINUTE, count: 1 } }
    expect(focusCandidate(now, DEFAULT_SETTINGS, notified, focused)).toBeNull()
    expect(focusCandidate(now + 90 * MINUTE, DEFAULT_SETTINGS, notified, focused)?.focus).toEqual({ since: now - 95 * MINUTE, count: 2 })
    expect(focusCandidate(now, DEFAULT_SETTINGS, createState(), activity({ focus: { category: 'coding', since: now - 30 * MINUTE } }))).toBeNull()
  })

  it('自发交互按平均间隔随机出现', () => {
    expect(spontaneousCandidates(() => 0, 30_000, 1).map((item) => item.trigger)).toEqual(['idle-animation', 'self-talk', 'topic'])
    expect(spontaneousCandidates(() => 0.99, 30_000, 1)).toEqual([])
    // 30 秒检查一次：小动作平均 4 分钟一次，概率为 1/8
    expect(spontaneousCandidates(() => 0.12, 30_000, 1).map((item) => item.trigger)).toEqual(['idle-animation'])
    expect(spontaneousCandidates(() => 0.13, 30_000, 1)).toEqual([])
  })
})
