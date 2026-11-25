import type { ActivityState } from '@/proactive/activity'
import type { TaskBrief } from '@/proactive/triggers'
import { describe, expect, it } from 'vitest'
import {
  dayKey,
  eventCandidates,
  festivalOf,
  focusCandidate,
  formatMinutes,
  inQuietHours,
  inWindow,
  lunarDate,
  sedentaryCandidate,
  spontaneousCandidates,
  taskDueCandidate,
  timeCandidates,
} from '@/proactive/triggers'
import { createState, DEFAULT_SETTINGS } from '@/proactive/types'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const at = (hours: number, minutes: number, day = 24) => new Date(2026, 10, day, hours, minutes).getTime()

function activity(overrides: Partial<ActivityState> = {}): ActivityState {
  return { available: true, present: true, presentSince: null, idleSeconds: 0, app: 'Code', category: 'coding', title: '', appSince: null, fullscreen: false, focus: null, ...overrides }
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

  it('下午茶：设定时间之后 90 分钟内', () => {
    expect(timeCandidates(at(15, 20), DEFAULT_SETTINGS, state(), activity())).toEqual([])
    expect(timeCandidates(at(15, 40), DEFAULT_SETTINGS, state(), activity())).toEqual([
      { trigger: 'afternoon-break', situation: '下午 15:40 了，正是容易犯困的时候', daily: true },
    ])
    expect(timeCandidates(at(17, 10), DEFAULT_SETTINGS, state(), activity())).toEqual([])
    expect(timeCandidates(at(16, 40), { ...DEFAULT_SETTINGS, afternoonBreakTime: '16:30' }, state(), activity()).map((item) => item.trigger)).toEqual(['afternoon-break'])
  })

  it('周末问候：只在周五 17:00 ~ 23:00', () => {
    // 2026-11-27 是周五，11-24 是周二
    expect(timeCandidates(at(18, 0, 27), DEFAULT_SETTINGS, state(), activity())).toEqual([
      { trigger: 'weekend', situation: '今天是周五，这周快结束了（现在 18:00）', daily: true },
    ])
    const triggers = (now: number) => timeCandidates(now, DEFAULT_SETTINGS, state(), activity()).map((item) => item.trigger)
    expect(triggers(at(16, 50, 27))).not.toContain('weekend')
    expect(triggers(at(23, 10, 27))).not.toContain('weekend')
    expect(triggers(at(18, 0, 24))).not.toContain('weekend')
  })
})

describe('节日', () => {
  const day = (year: number, month: number, date: number, hours = 10) => new Date(year, month - 1, date, hours, 0).getTime()

  it('农历：闰月单独标出', () => {
    expect(lunarDate(day(2026, 2, 17))).toEqual({ month: 1, day: 1, leap: false })
    // 2025 年有闰六月，7 月 25 日是闰六月初一
    expect(lunarDate(day(2025, 7, 25))).toEqual({ month: 6, day: 1, leap: true })
  })

  it('公历与农历的节日；除夕按农历新年的前一天算（2026 年腊月只有二十九天）', () => {
    expect(festivalOf(day(2026, 2, 17))).toBe('春节')
    expect(festivalOf(day(2026, 2, 16))).toBe('除夕')
    expect(festivalOf(day(2026, 9, 25))).toBe('中秋节')
    expect(festivalOf(day(2026, 10, 1))).toBe('国庆节')
    expect(festivalOf(day(2026, 12, 25))).toBe('圣诞节')
    expect(festivalOf(day(2020, 10, 1))).toBe('中秋节、国庆节')
    // 闰六月初一不是节日；普通的一天也不是
    expect(festivalOf(day(2025, 7, 25))).toBeNull()
    expect(festivalOf(at(10, 0))).toBeNull()
  })

  it('节日当天第一次见面时，节日问候排在每日问候前面，并且合成一句', () => {
    const springFestival = day(2026, 2, 17, 9)
    expect(timeCandidates(springFestival, DEFAULT_SETTINGS, createState(), activity())).toEqual([
      {
        trigger: 'festival',
        situation: '今天是春节；今天第一次见到用户（上午 09:00）',
        daily: true,
        alsoHandles: ['daily-greeting'],
        cooldown: { key: 'festival:2026-02-17', ms: DAY },
      },
      { trigger: 'daily-greeting', situation: '今天第一次见到用户（上午 09:00）', daily: true },
    ])
    // 已经问候过：单独送上节日问候；节日问候处理过之后不再出现；不在电脑前时不出现
    const greeted = { ...createState(), handledToday: ['daily-greeting' as const] }
    expect(timeCandidates(springFestival, DEFAULT_SETTINGS, greeted, activity())[0]).toMatchObject({ trigger: 'festival', situation: '今天是春节', alsoHandles: [] })
    expect(timeCandidates(springFestival, DEFAULT_SETTINGS, { ...greeted, handledToday: ['daily-greeting', 'festival'] }, activity())).toEqual([])
    expect(timeCandidates(springFestival, DEFAULT_SETTINGS, createState(), activity({ present: false }))).toEqual([])
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
      rest: true,
    })
    const notified = { ...createState(), focusNotified: { since: now - 95 * MINUTE, count: 1 } }
    expect(focusCandidate(now, DEFAULT_SETTINGS, notified, focused)).toBeNull()
    expect(focusCandidate(now + 90 * MINUTE, DEFAULT_SETTINGS, notified, focused)?.focus).toEqual({ since: now - 95 * MINUTE, count: 2 })
    expect(focusCandidate(now, DEFAULT_SETTINGS, createState(), activity({ focus: { category: 'coding', since: now - 30 * MINUTE } }))).toBeNull()
    // 半小时前刚提醒过休息（如久坐提醒），先不提醒
    expect(focusCandidate(now, DEFAULT_SETTINGS, { ...createState(), lastRestReminderAt: now - 30 * MINUTE }, focused)).toBeNull()
  })

  it('久坐：连续在电脑前达到设定的时间，和上一次提醒休息也要隔这么久', () => {
    const now = at(15, 0)
    const sitting = (minutes: number) => activity({ presentSince: now - minutes * MINUTE })
    expect(sedentaryCandidate(now, DEFAULT_SETTINGS, createState(), sitting(100))).toBeNull()
    expect(sedentaryCandidate(now, DEFAULT_SETTINGS, createState(), sitting(130))).toEqual({
      trigger: 'sedentary',
      situation: '用户已经在电脑前连续坐了 2 小时 10 分钟，中途没有离开过',
      rest: true,
    })
    // 40 分钟前提醒过休息（如长时间专注的提醒）：再过 80 分钟才提醒；隔够了就提醒，并说明之前提醒过
    expect(sedentaryCandidate(now, DEFAULT_SETTINGS, { ...createState(), lastRestReminderAt: now - 40 * MINUTE }, sitting(200))).toBeNull()
    expect(sedentaryCandidate(now, DEFAULT_SETTINGS, { ...createState(), lastRestReminderAt: now - 125 * MINUTE }, sitting(200))?.situation)
      .toBe('用户已经在电脑前连续坐了 3 小时 20 分钟，中途没有离开过（2 小时 5 分钟前提醒过休息）')
    // 不在电脑前、或者无法感知时不提醒
    expect(sedentaryCandidate(now, DEFAULT_SETTINGS, createState(), activity({ present: false, presentSince: null }))).toBeNull()
    expect(sedentaryCandidate(now, DEFAULT_SETTINGS, createState(), activity({ available: false }))).toBeNull()
  })

  it('待办快到期：一小时内到期、或者今天到期（下午 4 点后）还没完成的；设置了提醒的、做完的不算', () => {
    const now = at(15, 0)
    const task = (id: string, title: string, due: number | undefined, extra: Partial<TaskBrief> = {}): TaskBrief => ({ id, title, due, dueHasTime: true, done: false, ...extra })
    const tasks = [
      task('report', '写周报', at(15, 30)),
      task('later', '准备明天的会', at(16, 30)),
      task('today', '交作业', new Date(2026, 10, 24).getTime(), { dueHasTime: false }),
      task('reminded', '打电话', at(15, 10), { remindAt: at(15, 0) }),
      task('done', '买牛奶', at(15, 20), { done: true }),
      task('overdue', '交报销', at(10, 0)),
      task('yesterday', '回邮件', at(15, 0, 23)),
      task('no-due', '看书', undefined),
    ]
    expect(taskDueCandidate(now, createState(), tasks)).toEqual({
      trigger: 'task-due',
      situation: '有待办快到期了还没完成：「交报销」10:00 到期，已经过了 5 小时；「写周报」15:30 到期（还有 30 分钟）',
      cooldown: { key: ['task-due:overdue', 'task-due:report'], ms: DAY },
    })
    // 下午 4 点后，只有日期的待办也算；已经提过的不再提
    const mentioned = { ...createState(), cooldowns: { 'task-due:overdue': now + DAY, 'task-due:report': now + DAY } }
    expect(taskDueCandidate(at(16, 10), mentioned, tasks)?.situation).toBe('有待办快到期了还没完成：「交作业」今天到期；「准备明天的会」16:30 到期（还有 20 分钟）')
    expect(taskDueCandidate(now, mentioned, tasks)).toBeNull()
    // 一次最多提三个
    const many = [1, 2, 3, 4, 5].map((n) => task(`t${n}`, `待办${n}`, at(15, 10 * n)))
    expect(taskDueCandidate(now, createState(), many)?.situation).toContain('；另外还有 2 个')
  })

  it('事件：开会 10 分钟以上后离开算开完会，这个时机被拦下时再按切换应用处理', () => {
    expect(eventCandidates({ type: 'idle-return', awayMs: 30 * MINUTE })).toEqual([
      { trigger: 'idle-return', situation: '用户离开电脑 30 分钟后刚回来', cooldown: { key: 'idle-return', ms: 60 * MINUTE } },
    ])
    expect(eventCandidates({ type: 'fullscreen-exit', app: 'GenshinImpact', category: 'game', durationMs: 80 * MINUTE })).toEqual([
      { trigger: 'fullscreen-exit', situation: '用户刚退出全屏，之前全屏玩游戏 1 小时 20 分钟（GenshinImpact）', cooldown: { key: 'fullscreen-exit', ms: 60 * MINUTE } },
    ])
    const leftMeeting = { type: 'app-switch' as const, from: 'meeting' as const, to: 'coding' as const, app: 'Code', fromApp: 'Zoom', fromMs: 40 * MINUTE }
    expect(eventCandidates(leftMeeting)).toEqual([
      { trigger: 'meeting-end', situation: '用户刚离开会议（在 Zoom 中开了约 40 分钟），现在在编程（Code）', cooldown: { key: 'meeting-end', ms: 30 * MINUTE } },
      { trigger: 'app-switch', situation: '用户刚从开会换成了编程（Code）', cooldown: { key: 'app-switch', ms: 30 * MINUTE } },
    ])
    expect(eventCandidates({ ...leftMeeting, fromMs: 5 * MINUTE }).map((item) => item.trigger)).toEqual(['app-switch'])
    expect(eventCandidates({ ...leftMeeting, from: 'browser' }).map((item) => item.trigger)).toEqual(['app-switch'])
  })

  it('自发交互按平均间隔随机出现', () => {
    expect(spontaneousCandidates(() => 0, 30_000, 1).map((item) => item.trigger)).toEqual(['idle-animation', 'random-motion', 'self-talk', 'topic', 'share'])
    expect(spontaneousCandidates(() => 0.99, 30_000, 1)).toEqual([])
    // 30 秒检查一次：小动作平均 4 分钟一次，概率为 1/8
    expect(spontaneousCandidates(() => 0.12, 30_000, 1).map((item) => item.trigger)).toEqual(['idle-animation'])
    expect(spontaneousCandidates(() => 0.13, 30_000, 1)).toEqual([])
  })
})
