/**
 * 活动追踪：把 Rust 端定时查询到的原始状态（空闲秒数、前台窗口）整理成「情境」——
 * 用户在不在电脑前、在做哪一类事、连续专注了多久，并在情境变化时产生事件。
 *
 * 原始信号很碎（切一下窗口、几秒不动鼠标），直接拿来触发会很吵，因此：
 * - 新的应用持续使用一段时间后才算「切换」；
 * - 连续专注允许中途短暂切到别的应用；
 * - 离开一段时间后回来才算「回到电脑前」；
 * - 全屏持续足够久、退出后一段时间没有再回到全屏，才算「结束全屏」。
 */

/** Rust 端返回的活动状态 */
export interface ActivitySnapshot {
  /** 距离最后一次操作键盘鼠标的秒数；无法获取时为空（如非 Windows 系统） */
  idleSeconds: number | null
  foreground: {
    /** 进程名，如 Code、chrome */
    app: string
    title: string
    fullscreen: boolean
    /** 是否是桌宠自己的窗口 */
    own: boolean
  } | null
}

export type AppCategory = 'coding' | 'browser' | 'office' | 'chat' | 'meeting' | 'media' | 'game' | 'design' | 'other'

export const APP_CATEGORY_LABELS: Record<AppCategory, string> = {
  coding: '编程',
  browser: '浏览网页',
  office: '处理文档',
  chat: '聊天',
  meeting: '开会',
  media: '看视频或听音乐',
  game: '玩游戏',
  design: '做设计',
  other: '使用其他应用',
}

// 常见应用的进程名（小写，不含扩展名）
const APP_CATEGORIES: Record<Exclude<AppCategory, 'other'>, string[]> = {
  coding: [
    'code', 'code - insiders', 'cursor', 'windsurf', 'trae', 'devenv', 'idea64', 'idea', 'pycharm64', 'pycharm', 'webstorm64', 'clion64',
    'goland64', 'rider64', 'phpstorm64', 'rustrover64', 'studio64', 'sublime_text', 'notepad++', 'zed', 'fleet', 'hbuilderx',
    'windowsterminal', 'wt', 'cmd', 'powershell', 'pwsh', 'wezterm-gui', 'alacritty', 'mintty', 'git-bash', 'nvim-qt', 'gvim', 'emacs',
  ],
  browser: ['chrome', 'msedge', 'firefox', 'opera', 'brave', 'vivaldi', 'arc', '360se', '360chrome', 'qqbrowser', 'sogouexplorer', 'quark'],
  office: [
    'winword', 'excel', 'powerpnt', 'onenote', 'wps', 'et', 'wpp', 'wpsoffice', 'acrobat', 'acrord32', 'foxitpdfreader',
    'notion', 'obsidian', 'typora', 'logseq', 'yuque', 'wiz',
  ],
  chat: ['wechat', 'weixin', 'qq', 'tim', 'dingtalk', 'feishu', 'lark', 'slack', 'discord', 'telegram', 'whatsapp', 'wecom', 'wxwork'],
  meeting: ['zoom', 'teams', 'ms-teams', 'wemeetapp', 'voovmeeting', 'webex', 'skype'],
  media: [
    'potplayermini64', 'potplayermini', 'potplayer', 'vlc', 'mpv', 'mpc-hc64', 'cloudmusic', 'qqmusic', 'kugou', 'kwmusic', 'spotify',
    'applemusic', 'bilibili', '哔哩哔哩', 'iqiyi', 'youku', 'qqlive', 'tencentvideo',
  ],
  game: ['steam', 'steamwebhelper', 'epicgameslauncher', 'wegame', 'genshinimpact', 'yuanshen', 'starrail', 'zenlesszonezero', 'league of legends', 'minecraft', 'javaw'],
  design: ['photoshop', 'illustrator', 'figma', 'blender', 'afterfx', 'premiere', 'adobe premiere pro', 'davinci resolve', 'resolve', 'sketchup', 'krita', 'clipstudiopaint', 'mspaint'],
}

// 只看进程名分不清时（如浏览器里看视频、开网页会议），根据窗口标题判断。标题只在本地使用
const TITLE_HINTS: [RegExp, AppCategory][] = [
  [/腾讯会议|飞书会议|钉钉会议|zoom meeting|google meet|teams 会议|会议中/i, 'meeting'],
  [/bilibili|哔哩哔哩|youtube|爱奇艺|优酷|腾讯视频|netflix|抖音|twitch|网易云音乐|qq音乐/i, 'media'],
  [/github|gitlab|stack overflow|leetcode|力扣|localhost|127\.0\.0\.1/i, 'coding'],
]

const APP_LOOKUP = new Map<string, AppCategory>(
  Object.entries(APP_CATEGORIES).flatMap(([category, apps]) => apps.map((app) => [app, category as AppCategory])),
)

/** 根据进程名与窗口标题判断应用的类型 */
export function categorizeApp(app: string, title = ''): AppCategory {
  const byApp = APP_LOOKUP.get(app.trim().toLowerCase()) ?? 'other'
  // 浏览器、聊天工具里也可能在看视频、开会；其他类型的应用以进程名为准
  if (byApp === 'browser' || byApp === 'chat' || byApp === 'other') {
    const hinted = TITLE_HINTS.find(([pattern]) => pattern.test(title))?.[1]
    if (hinted && !(byApp === 'chat' && hinted === 'coding')) return hinted
  }
  return byApp
}

/** 整理后的用户状态 */
export interface ActivityState {
  /** 能否感知用户的活动（非 Windows 系统上只能当作一直在电脑前） */
  available: boolean
  /** 是否在电脑前：最近一段时间内操作过键盘鼠标 */
  present: boolean
  /** 这次连续在电脑前是从什么时候开始的（离开一段时间算中断）；无法感知或者不在电脑前时为空 */
  presentSince: number | null
  idleSeconds: number
  /** 正在使用的应用（持续使用了一段时间才算） */
  app: string | null
  category: AppCategory | null
  title: string
  /** 开始使用当前应用的时间 */
  appSince: number | null
  /** 前台窗口是否全屏 */
  fullscreen: boolean
  /** 连续专注于同一类应用的时间段（短暂切到别的应用不算打断） */
  focus: { category: AppCategory, since: number } | null
}

export type ActivityEvent =
  | { type: 'idle-return', awayMs: number }
  /** fromApp / fromMs：之前用的是哪个应用、用了多久 */
  | { type: 'app-switch', from: AppCategory, to: AppCategory, app: string, fromApp: string, fromMs: number }
  /** 退出了持续 durationMs 的全屏 */
  | { type: 'fullscreen-exit', app: string, category: AppCategory, durationMs: number }

export interface TrackerOptions {
  /** 多久不操作键盘鼠标算离开 */
  awaySeconds?: number
  /** 离开多久后回来才算「回到电脑前」 */
  returnAfterMs?: number
  /** 新的应用持续使用多久才算切换；退出全屏后多久没有回去才算结束全屏 */
  dwellMs?: number
  /** 专注时允许切到别的应用（或离开）多久而不打断 */
  focusGraceMs?: number
  /** 全屏持续多久后退出才算「结束全屏」 */
  fullscreenMinMs?: number
}

const MINUTE = 60_000

export class ActivityTracker {
  private readonly awaySeconds: number
  private readonly returnAfterMs: number
  private readonly dwellMs: number
  private readonly focusGraceMs: number
  private readonly fullscreenMinMs: number

  private available = false
  private idleSeconds = 0
  private awaySince: number | null = null
  /** 最近一次离开后回来的时间，刚开始追踪时为第一次看到用户的时间（专注、久坐的时间从这之后算起） */
  private presentSince: number | null = null
  private fullscreen = false
  /** 正在进行的全屏，以及退出全屏的时间（退出后一段时间没有回去才算结束） */
  private fullscreenSession: { app: string, category: AppCategory, since: number } | null = null
  private fullscreenEndedAt: number | null = null
  private current: { app: string, category: AppCategory, title: string, since: number } | null = null
  private pending: { app: string, category: AppCategory, title: string, since: number } | null = null
  private focus: { category: AppCategory, since: number, lastSeen: number } | null = null

  constructor(options: TrackerOptions = {}) {
    this.awaySeconds = options.awaySeconds ?? 5 * 60
    this.returnAfterMs = options.returnAfterMs ?? 10 * MINUTE
    this.dwellMs = options.dwellMs ?? MINUTE
    this.focusGraceMs = options.focusGraceMs ?? 5 * MINUTE
    this.fullscreenMinMs = options.fullscreenMinMs ?? 30 * MINUTE
  }

  /** 根据新的快照更新状态，返回这次产生的事件 */
  update(snapshot: ActivitySnapshot, now: number): ActivityEvent[] {
    const events: ActivityEvent[] = []
    this.available = snapshot.idleSeconds !== null || snapshot.foreground !== null
    this.idleSeconds = snapshot.idleSeconds ?? 0

    // 离开与回来：离开的开始时间是最后一次操作的时间
    const lastInput = now - this.idleSeconds * 1000
    if (this.idleSeconds >= this.awaySeconds) {
      this.awaySince ??= lastInput
    }
    else {
      if (this.awaySince !== null) {
        const awayMs = lastInput - this.awaySince
        this.awaySince = null
        this.presentSince = lastInput
        if (awayMs >= this.returnAfterMs) events.push({ type: 'idle-return', awayMs })
      }
      // 刚开始追踪时，从第一次看到用户在电脑前算起
      this.presentSince ??= lastInput
    }

    // 前台应用：桌面与桌宠自己的窗口不改变「正在使用的应用」
    const foreground = snapshot.foreground
    this.fullscreen = !!foreground && !foreground.own && foreground.fullscreen
    this.trackFullscreen(foreground, now, events)
    if (foreground && !foreground.own && foreground.app) {
      const category = categorizeApp(foreground.app, foreground.title)
      if (this.current?.app === foreground.app) {
        this.current.title = foreground.title
        this.current.category = category
        this.pending = null
      }
      else if (this.pending?.app === foreground.app) {
        this.pending.title = foreground.title
        this.pending.category = category
        if (now - this.pending.since >= this.dwellMs) {
          const previous = this.current
          this.current = this.pending
          this.pending = null
          if (previous && previous.category !== this.current.category) {
            events.push({
              type: 'app-switch',
              from: previous.category,
              to: this.current.category,
              app: this.current.app,
              fromApp: previous.app,
              fromMs: this.current.since - previous.since,
            })
          }
        }
      }
      else {
        this.pending = { app: foreground.app, category, title: foreground.title, since: now }
        // 刚开始追踪时没有正在使用的应用，直接作为当前应用
        if (!this.current) {
          this.current = this.pending
          this.pending = null
        }
      }
    }

    this.updateFocus(now)
    return events
  }

  /** 全屏持续足够久、退出后一段时间没有再回到全屏，才算结束（短暂切出去又切回来不算） */
  private trackFullscreen(foreground: ActivitySnapshot['foreground'], now: number, events: ActivityEvent[]) {
    if (this.fullscreen && foreground) {
      this.fullscreenSession ??= { app: foreground.app, category: categorizeApp(foreground.app, foreground.title), since: now }
      this.fullscreenEndedAt = null
      return
    }
    if (!this.fullscreenSession) return
    this.fullscreenEndedAt ??= now
    if (now - this.fullscreenEndedAt < this.dwellMs) return

    const { app, category, since } = this.fullscreenSession
    const durationMs = this.fullscreenEndedAt - since
    this.fullscreenSession = null
    this.fullscreenEndedAt = null
    if (durationMs >= this.fullscreenMinMs) events.push({ type: 'fullscreen-exit', app, category, durationMs })
  }

  private updateFocus(now: number) {
    const present = this.idleSeconds < this.awaySeconds
    if (!present || !this.current) return
    const { category } = this.current
    if (this.focus && now - this.focus.lastSeen > this.focusGraceMs) this.focus = null
    if (this.focus?.category === category) {
      this.focus.lastSeen = now
    }
    else if (!this.focus) {
      // 长时间做别的事、或者离开回来之后，从开始使用这个应用（或者回来）的时候重新计算
      this.focus = { category, since: Math.max(this.current.since, this.presentSince ?? 0), lastSeen: now }
    }
  }

  get state(): ActivityState {
    const present = this.idleSeconds < this.awaySeconds
    return {
      available: this.available,
      present: !this.available || present,
      presentSince: this.available && present ? this.presentSince : null,
      idleSeconds: this.idleSeconds,
      app: this.current?.app ?? null,
      category: this.current?.category ?? null,
      title: this.current?.title ?? '',
      appSince: this.current?.since ?? null,
      fullscreen: this.fullscreen,
      focus: this.focus ? { category: this.focus.category, since: this.focus.since } : null,
    }
  }
}
