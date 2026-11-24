import type { ActivitySnapshot } from '@/proactive/activity'
import { describe, expect, it } from 'vitest'
import { ActivityTracker, categorizeApp } from '@/proactive/activity'

const MINUTE = 60_000
const T0 = new Date(2026, 10, 24, 9, 0).getTime()

function foreground(app: string, title = '', extra: Partial<NonNullable<ActivitySnapshot['foreground']>> = {}) {
  return { app, title, fullscreen: false, own: false, ...extra }
}

function snapshot(idleSeconds: number | null, fg: ActivitySnapshot['foreground']): ActivitySnapshot {
  return { idleSeconds, foreground: fg }
}

describe('应用分类', () => {
  it('按进程名分类；浏览器、聊天工具里看视频、开会时参考窗口标题', () => {
    expect(categorizeApp('Code')).toBe('coding')
    expect(categorizeApp('WINWORD')).toBe('office')
    expect(categorizeApp('chrome', '新标签页')).toBe('browser')
    expect(categorizeApp('chrome', 'GitHub - desktop-pet')).toBe('coding')
    expect(categorizeApp('msedge', '【测评】新显卡_哔哩哔哩_bilibili')).toBe('media')
    expect(categorizeApp('WeChat', '腾讯会议')).toBe('meeting')
    expect(categorizeApp('WeChat', 'GitHub 链接')).toBe('chat')
    expect(categorizeApp('some-tool')).toBe('other')
  })
})

describe('活动追踪', () => {
  it('离开足够久后回来，产生「回到电脑前」', () => {
    const tracker = new ActivityTracker()
    tracker.update(snapshot(0, foreground('Code')), T0)
    expect(tracker.update(snapshot(20 * 60, foreground('Code')), T0 + 20 * MINUTE)).toEqual([])
    expect(tracker.state.present).toBe(false)

    expect(tracker.update(snapshot(1, foreground('Code')), T0 + 21 * MINUTE)).toEqual([{ type: 'idle-return', awayMs: 21 * MINUTE - 1000 }])
    expect(tracker.state.present).toBe(true)
  })

  it('离开的时间不够长时不算回来', () => {
    const tracker = new ActivityTracker()
    tracker.update(snapshot(0, foreground('Code')), T0)
    tracker.update(snapshot(6 * 60, foreground('Code')), T0 + 6 * MINUTE)
    expect(tracker.update(snapshot(0, foreground('Code')), T0 + 7 * MINUTE)).toEqual([])
  })

  it('新的应用持续使用一段时间后才算切换；桌宠自己的窗口与桌面不算', () => {
    const tracker = new ActivityTracker()
    tracker.update(snapshot(0, foreground('Code')), T0)
    expect(tracker.update(snapshot(0, foreground('chrome', 'xxx_哔哩哔哩_bilibili')), T0 + 10_000)).toEqual([])
    expect(tracker.state.app).toBe('Code')

    expect(tracker.update(snapshot(0, foreground('chrome', 'xxx_哔哩哔哩_bilibili')), T0 + 80_000)).toEqual([
      { type: 'app-switch', from: 'coding', to: 'media', app: 'chrome' },
    ])
    tracker.update(snapshot(0, foreground('desktop-pet', '', { own: true })), T0 + 200_000)
    tracker.update(snapshot(0, null), T0 + 300_000)
    expect(tracker.state.app).toBe('chrome')
  })

  it('换成同一类应用时不产生事件', () => {
    const tracker = new ActivityTracker()
    tracker.update(snapshot(0, foreground('Code')), T0)
    tracker.update(snapshot(0, foreground('WindowsTerminal')), T0 + 1000)
    expect(tracker.update(snapshot(0, foreground('WindowsTerminal')), T0 + 2 * MINUTE)).toEqual([])
    expect(tracker.state.app).toBe('WindowsTerminal')
  })

  it('连续专注：短暂切到别的应用不打断，离开太久后从回来时重新计算', () => {
    const tracker = new ActivityTracker()
    tracker.update(snapshot(0, foreground('Code')), T0)
    tracker.update(snapshot(0, foreground('Code')), T0 + 30 * MINUTE)
    expect(tracker.state.focus).toEqual({ category: 'coding', since: T0 })

    // 去浏览器查了 3 分钟资料再回来
    tracker.update(snapshot(0, foreground('chrome')), T0 + 31 * MINUTE)
    tracker.update(snapshot(0, foreground('chrome')), T0 + 33 * MINUTE)
    tracker.update(snapshot(0, foreground('Code')), T0 + 34 * MINUTE)
    tracker.update(snapshot(0, foreground('Code')), T0 + 35 * MINUTE + 1)
    expect(tracker.state.focus).toEqual({ category: 'coding', since: T0 })

    // 离开 20 分钟后回来
    tracker.update(snapshot(20 * 60, foreground('Code')), T0 + 56 * MINUTE)
    tracker.update(snapshot(0, foreground('Code')), T0 + 57 * MINUTE)
    expect(tracker.state.focus).toEqual({ category: 'coding', since: T0 + 57 * MINUTE })
  })

  it('全屏只看当前的前台窗口；无法获取活动状态时当作一直在电脑前', () => {
    const tracker = new ActivityTracker()
    tracker.update(snapshot(0, foreground('PotPlayerMini64', '', { fullscreen: true })), T0)
    expect(tracker.state.fullscreen).toBe(true)
    tracker.update(snapshot(0, foreground('desktop-pet', '', { own: true, fullscreen: true })), T0 + 1000)
    expect(tracker.state.fullscreen).toBe(false)

    const unavailable = new ActivityTracker()
    unavailable.update(snapshot(null, null), T0)
    expect(unavailable.state).toMatchObject({ available: false, present: true, app: null })
  })
})
