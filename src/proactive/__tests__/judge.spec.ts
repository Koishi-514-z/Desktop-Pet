import type { ActivityState } from '@/proactive/activity'
import { describe, expect, it } from 'vitest'
import { buildJudgeSystemPrompt, buildSpeakEvent, describeContext, parseDecision } from '@/proactive/judge'
import { createState, triggerInfo } from '@/proactive/types'

const MINUTE = 60_000
const NOW = new Date(2026, 10, 24, 15, 0).getTime()

const coding: ActivityState = {
  available: true,
  present: true,
  idleSeconds: 3,
  app: 'Code',
  category: 'coding',
  title: 'executor.ts - desktop-pet',
  appSince: NOW - 40 * MINUTE,
  fullscreen: false,
  focus: { category: 'coding', since: NOW - 100 * MINUTE },
}

describe('判断要不要说', () => {
  it('解析判断结果：只能使用提供的技能，无法解析时不说', () => {
    expect(parseDecision('{"speak": true, "reason": "饭点", "intent": "提醒吃饭", "skills": ["weather", "files"]}', ['weather'])).toEqual({
      speak: true,
      reason: '饭点',
      intent: '提醒吃饭',
      skills: ['weather'],
    })
    expect(parseDecision('```json\n{"speak": "true", "intent": "问候"}\n```', [])).toMatchObject({ speak: true, intent: '问候', skills: [] })
    expect(parseDecision('我觉得应该说', ['weather'])).toEqual({ speak: false, reason: '无法解析判断结果', intent: '', skills: [] })
  })

  it('当前情况：时间、用户在做什么、今天说过的话、被忽略的次数、最近的对话', () => {
    const state = { ...createState(), spokenToday: 2, ignoredStreak: 1, recentLines: [{ at: NOW - 60 * MINUTE, trigger: 'lunch' as const, text: '该吃午饭啦' }] }
    const text = describeContext({
      now: NOW,
      activity: coding,
      shareWindowTitle: false,
      state,
      assistantName: '小桌',
      recentDialog: [{ role: 'user', content: '帮我看看这个报错' }, { role: 'assistant', content: '是空指针' }],
    })
    expect(text).toContain('- 现在：2026-11-24 15:00 星期二（下午）')
    expect(text).toContain('- 用户正在编程（Code），已经用了 40 分钟，连续编程 1 小时 40 分钟')
    expect(text).not.toContain('executor.ts')
    expect(text).toContain('- 今天已经主动说话 2 次，最近一次在 14:00：「该吃午饭啦」')
    expect(text).toContain('- 最近 1 次主动说话，用户都没有回应')
    expect(text).toContain('  用户：帮我看看这个报错\n  小桌：是空指针')
  })

  it('用户同意时才把窗口标题告诉模型；不在电脑前、无法感知时如实说明', () => {
    const base = { now: NOW, state: createState(), assistantName: '小桌' }
    expect(describeContext({ ...base, activity: coding, shareWindowTitle: true })).toContain('- 窗口标题：executor.ts - desktop-pet')
    expect(describeContext({ ...base, activity: { ...coding, present: false, idleSeconds: 600 }, shareWindowTitle: false })).toContain('- 用户已经 10 分钟没有操作电脑了')
    expect(describeContext({ ...base, activity: null, shareWindowTitle: false })).toContain('- 用户在做什么：不知道（无法获取前台应用）')
  })

  it('提示中列出可以用来获取信息的技能；生成时附上时机的说话要求', () => {
    expect(buildJudgeSystemPrompt('小桌', [{ id: 'weather', name: '天气', description: '查询天气' }])).toContain('  - weather（天气）：查询天气')
    const event = buildSpeakEvent(triggerInfo('self-talk'), '有一会儿没说话了', '感慨一下下午犯困', '- 现在：15:00')
    expect(event).toContain('这是一次主动交互（自言自语）：有一会儿没说话了。')
    expect(event).toContain('你打算：感慨一下下午犯困')
    expect(event).toContain('这是自言自语，不是对用户说的话')
  })
})
