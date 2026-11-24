import type { ActivityState } from '@/proactive/activity'
import type { EngineDeps } from '@/proactive/engine'
import type { ProactiveDecision } from '@/proactive/judge'
import type { ProactiveLogEntry, ProactiveSettings, ProactiveState, TriggerId } from '@/proactive/types'
import { describe, expect, it, vi } from 'vitest'
import { ProactiveEngine, REPLY_WINDOW_MS } from '@/proactive/engine'
import { dayKey } from '@/proactive/triggers'
import { createState, mergeSettings } from '@/proactive/types'

const MINUTE = 60_000
const at = (hours: number, minutes: number, day = 24) => new Date(2026, 10, day, hours, minutes).getTime()

function setup(options: { now?: number, handled?: TriggerId[], random?: number, decision?: Partial<ProactiveDecision>, settings?: Partial<ProactiveSettings> } = {}) {
  let now = options.now ?? at(12, 5)
  const state: ProactiveState = { ...createState(dayKey(now)), handledToday: options.handled ?? ['daily-greeting'] }
  const settings = mergeSettings(options.settings ?? {})
  const logs: ProactiveLogEntry[] = []
  let activity: ActivityState | null = {
    available: true,
    present: true,
    idleSeconds: 0,
    app: 'Code',
    category: 'coding',
    title: 'main.ts',
    appSince: now - 20 * MINUTE,
    fullscreen: false,
    focus: { category: 'coding', since: now - 20 * MINUTE },
  }
  const conversation = { busy: false, lastUserMessageAt: 0, recentDialog: [] }
  const judge = vi.fn<EngineDeps['judge']>(async () => ({ speak: true, reason: '时机合适', intent: '提醒吃午饭', skills: ['weather'], ...options.decision }))
  const speak = vi.fn<EngineDeps['speak']>(async () => '该吃午饭啦，今天外面有点冷')
  const animate = vi.fn()
  const engine = new ProactiveEngine({
    now: () => now,
    random: () => options.random ?? 0.99,
    settings: () => settings,
    state: () => state,
    activity: () => activity,
    conversation: () => conversation,
    assistantName: () => '小桌',
    judge,
    speak,
    animate,
    log: (entry) => logs.push(entry),
  })
  return {
    engine,
    state,
    settings,
    logs,
    judge,
    speak,
    animate,
    conversation,
    advance: (ms: number) => { now += ms },
    setActivity: (patch: Partial<ActivityState>) => { activity = { ...activity!, ...patch } },
  }
}

describe('主动交互', () => {
  it('饭点：本地筛选通过后先问模型，决定说就带着需要的技能生成，并记下次数与说过的话', async () => {
    const { engine, state, logs, judge, speak, advance } = setup()
    await engine.tick()

    expect(judge).toHaveBeenCalledTimes(1)
    expect(judge.mock.calls[0]![0]).toMatchObject({ trigger: { id: 'lunch' }, situation: '到午饭时间了（现在 12:05）' })
    expect(judge.mock.calls[0]![0].context).toContain('用户正在编程（Code）')
    expect(speak).toHaveBeenCalledWith(expect.objectContaining({ trigger: expect.objectContaining({ id: 'lunch' }), skills: ['weather'] }))
    expect(speak.mock.calls[0]![0].event).toContain('你打算：提醒吃午饭')
    expect(state).toMatchObject({ spokenToday: 1, lastSpokeAt: at(12, 5), handledToday: ['daily-greeting', 'lunch'], awaitingReplyUntil: at(12, 5) + REPLY_WINDOW_MS })
    expect(state.recentLines).toEqual([{ at: at(12, 5), trigger: 'lunch', text: '该吃午饭啦，今天外面有点冷' }])
    expect(logs).toEqual([{ at: at(12, 5), trigger: 'lunch', outcome: 'spoke', reason: '时机合适', text: '该吃午饭啦，今天外面有点冷' }])

    // 今天已经提醒过，不会再提醒
    advance(MINUTE)
    await engine.tick()
    expect(judge).toHaveBeenCalledTimes(1)
  })

  it('被本地筛选拦下时不调用模型，同样的原因只记录一次；时间窗口内条件满足后再试', async () => {
    const { engine, settings, logs, judge, advance } = setup()
    settings.dndUntil = at(12, 5) + 30 * MINUTE
    await engine.tick()
    advance(MINUTE)
    await engine.tick()
    expect(judge).not.toHaveBeenCalled()
    expect(logs).toEqual([{ at: at(12, 5), trigger: 'lunch', outcome: 'blocked', reason: '免打扰中' }])

    settings.dndUntil = 0
    advance(MINUTE)
    await engine.tick()
    expect(judge).toHaveBeenCalledTimes(1)
  })

  it('模型决定不说时记下理由，今天不再问', async () => {
    const { engine, logs, judge, speak, advance } = setup({ decision: { speak: false, reason: '用户正在专注调试' } })
    await engine.tick()
    advance(MINUTE)
    await engine.tick()
    expect(judge).toHaveBeenCalledTimes(1)
    expect(speak).not.toHaveBeenCalled()
    expect(logs).toEqual([{ at: at(12, 5), trigger: 'lunch', outcome: 'declined', reason: '用户正在专注调试' }])
  })

  it('判断出错时记下错误，也算处理过，不会马上重试', async () => {
    const { engine, logs, judge, state } = setup()
    judge.mockRejectedValueOnce(new Error('401 Unauthorized'))
    await engine.tick()
    expect(logs).toEqual([{ at: at(12, 5), trigger: 'lunch', outcome: 'failed', reason: '401 Unauthorized' }])
    expect(state.handledToday).toContain('lunch')
  })

  it('主动说话后用户没有回应就记一次忽略，拉长之后的间隔；回应了就恢复', async () => {
    const { engine, state, advance } = setup()
    await engine.tick()
    advance(REPLY_WINDOW_MS + MINUTE)
    await engine.tick()
    expect(state).toMatchObject({ ignoredStreak: 1, awaitingReplyUntil: 0 })

    state.awaitingReplyUntil = at(12, 5) + 2 * REPLY_WINDOW_MS
    engine.noteUserMessage()
    expect(state).toMatchObject({ ignoredStreak: 0, awaitingReplyUntil: 0 })
  })

  it('回到电脑前：由活动事件触发，冷却时间内不重复', async () => {
    const { engine, judge } = setup({ now: at(15, 0), handled: ['daily-greeting', 'lunch'] })
    await engine.onActivityEvents([{ type: 'idle-return', awayMs: 30 * MINUTE }])
    expect(judge.mock.calls[0]![0]).toMatchObject({ trigger: { id: 'idle-return' }, situation: '用户离开电脑 30 分钟后刚回来' })

    await engine.onActivityEvents([{ type: 'idle-return', awayMs: 15 * MINUTE }])
    expect(judge).toHaveBeenCalledTimes(1)
  })

  it('连续专注很久时提醒休息，同一段专注之后要再专注同样久才提醒', async () => {
    const { engine, state, judge, setActivity, advance } = setup({ now: at(15, 0), handled: ['daily-greeting', 'lunch'] })
    const since = at(15, 0) - 95 * MINUTE
    setActivity({ focus: { category: 'coding', since } })
    await engine.tick()
    expect(judge.mock.calls[0]![0]).toMatchObject({ trigger: { id: 'long-focus' }, situation: '用户已经连续编程 1 小时 35 分钟' })
    expect(state.focusNotified).toEqual({ since, count: 1 })

    advance(30 * MINUTE)
    await engine.tick()
    expect(judge).toHaveBeenCalledTimes(1)
  })

  it('自发的时机按经过的时间计算概率：刚开始检查、或者两次检查之间没有经过时间时不会出现', async () => {
    const { engine, judge, animate } = setup({ now: at(15, 0), handled: ['daily-greeting', 'lunch'], random: 0 })
    await engine.tick()
    await engine.tick()
    expect(animate).not.toHaveBeenCalled()
    expect(judge).not.toHaveBeenCalled()
  })

  it('经过一段时间后按概率出现小动作，只在本地完成，不调用模型', async () => {
    const { engine, judge, animate, advance } = setup({ now: at(15, 0), handled: ['daily-greeting', 'lunch'], random: 0 })
    await engine.tick()
    advance(30_000)
    await engine.tick()
    expect(animate).toHaveBeenCalledTimes(1)
    expect(judge).not.toHaveBeenCalled()
  })

  it('新的一天重置每日的计数，第一次见到用户时问候', async () => {
    const { engine, state, judge } = setup({ now: at(9, 0, 25) })
    Object.assign(state, { day: '2026-11-24', spokenToday: 5, handledToday: ['daily-greeting', 'lunch'] })
    await engine.tick()
    expect(state.day).toBe('2026-11-25')
    expect(judge.mock.calls[0]![0]).toMatchObject({ trigger: { id: 'daily-greeting' } })
    expect(state).toMatchObject({ spokenToday: 1, handledToday: ['daily-greeting'] })
  })

  it('试一下：跳过时机开关与频率限制，但仍然遵守免打扰', async () => {
    const { engine, settings, state, judge } = setup({ now: at(15, 0), handled: ['daily-greeting', 'lunch'] })
    settings.triggers.topic = false
    state.lastSpokeAt = at(15, 0) - MINUTE
    expect(await engine.tryNow('topic')).toBe('spoke')
    expect(judge).toHaveBeenCalledTimes(1)

    settings.dndUntil = at(16, 0)
    expect(await engine.tryNow('topic')).toBe('blocked')
    expect(judge).toHaveBeenCalledTimes(1)
  })

  it('同一时间只处理一个时机', async () => {
    const { engine, judge } = setup()
    let release!: () => void
    judge.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ speak: false, reason: '', intent: '', skills: [] })
    }))
    const first = engine.tick()
    await Promise.resolve()
    expect(engine.busy).toBe(true)
    expect(await engine.tryNow('topic')).toBe('busy')
    release()
    await first
    expect(engine.busy).toBe(false)
  })
})
