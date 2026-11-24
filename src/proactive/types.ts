/**
 * 主动交互：桌宠在合适的时机主动和用户说话，或者做个小动作。
 *
 * 流程：时机（时间、事件、上下文、自发）→ 本地筛选（免打扰、全屏、频率等，不调用模型）
 * → 小模型判断要不要说、说什么 → 对话模型以角色口吻生成（需要时用只读的工具查天气、待办等）。
 */

export type TriggerId =
  | 'daily-greeting'
  | 'lunch'
  | 'dinner'
  | 'late-night'
  | 'idle-return'
  | 'app-switch'
  | 'long-focus'
  | 'idle-animation'
  | 'self-talk'
  | 'topic'

export type TriggerGroup = 'time' | 'event' | 'context' | 'spontaneous'

export interface TriggerInfo {
  id: TriggerId
  group: TriggerGroup
  label: string
  description: string
  /** speech：要说话（经过模型判断与生成）；animation：只播放表情或动作，不调用模型 */
  kind: 'speech' | 'animation'
  /** 优先级高的时机（如提醒吃饭、休息）与上次主动说话的间隔可以短一些，低的要长一些 */
  priority: 'high' | 'normal' | 'low'
  /** 生成时对说话方式的额外要求 */
  guidance?: string
}

export const TRIGGER_GROUP_LABELS: Record<TriggerGroup, string> = {
  time: '时间',
  event: '事件',
  context: '上下文',
  spontaneous: '自发',
}

export const TRIGGERS: TriggerInfo[] = [
  {
    id: 'daily-greeting',
    group: 'time',
    label: '每日问候',
    description: '每天第一次见到你时打个招呼（当天第一次启动，或者新的一天第一次回到电脑前）',
    kind: 'speech',
    priority: 'normal',
  },
  {
    id: 'lunch',
    group: 'time',
    label: '午饭时间',
    description: '到了午饭时间，提醒你吃饭',
    kind: 'speech',
    priority: 'high',
  },
  {
    id: 'dinner',
    group: 'time',
    label: '晚饭时间',
    description: '到了晚饭时间，提醒你吃饭',
    kind: 'speech',
    priority: 'high',
  },
  {
    id: 'late-night',
    group: 'time',
    label: '深夜提醒',
    description: '很晚了还在用电脑时，提醒你早点休息',
    kind: 'speech',
    priority: 'high',
  },
  {
    id: 'idle-return',
    group: 'event',
    label: '回到电脑前',
    description: '离开电脑一段时间（10 分钟以上）后回来时打个招呼',
    kind: 'speech',
    priority: 'normal',
  },
  {
    id: 'app-switch',
    group: 'event',
    label: '切换应用',
    description: '你换去做另一类事情时（如写完代码去看视频），看情况说一句',
    kind: 'speech',
    priority: 'low',
  },
  {
    id: 'long-focus',
    group: 'context',
    label: '长时间专注',
    description: '在同一类应用中（如 IDE）连续工作很久时，提醒你活动一下',
    kind: 'speech',
    priority: 'high',
  },
  {
    id: 'idle-animation',
    group: 'spontaneous',
    label: '小动作',
    description: '时不时换个表情，不说话，也不调用模型',
    kind: 'animation',
    priority: 'low',
  },
  {
    id: 'self-talk',
    group: 'spontaneous',
    label: '自言自语',
    description: '偶尔嘀咕一句，不需要你回应',
    kind: 'speech',
    priority: 'low',
    guidance: '这是自言自语，不是对用户说的话：轻轻嘀咕一句，比如对时间、天气、自己心情的感慨，不要向用户提问。',
  },
  {
    id: 'topic',
    group: 'spontaneous',
    label: '主动聊天',
    description: '偶尔根据记得的事或你关心的话题，主动找你聊聊',
    kind: 'speech',
    priority: 'low',
    guidance: '主动发起一个轻松的话题，最好和用户的近况、计划或兴趣有关（可以参考记得的事），可以问一个简单的问题。',
  },
]

export function triggerInfo(id: TriggerId): TriggerInfo {
  return TRIGGERS.find((trigger) => trigger.id === id)!
}

export type Frequency = 'low' | 'normal' | 'high'

export interface FrequencyPreset {
  label: string
  /** 两次主动说话之间的最短间隔 */
  minIntervalMs: number
  /** 每天最多主动说话的次数 */
  dailyLimit: number
  /** 自发交互（自言自语、主动聊天）的频率倍数 */
  spontaneousScale: number
}

const MINUTE = 60_000

export const FREQUENCY_PRESETS: Record<Frequency, FrequencyPreset> = {
  low: { label: '少', minIntervalMs: 60 * MINUTE, dailyLimit: 6, spontaneousScale: 0.5 },
  normal: { label: '适中', minIntervalMs: 30 * MINUTE, dailyLimit: 12, spontaneousScale: 1 },
  high: { label: '多', minIntervalMs: 15 * MINUTE, dailyLimit: 24, spontaneousScale: 2 },
}

export interface ProactiveSettings {
  enabled: boolean
  /** 免打扰到什么时候（时间戳），0 表示没有开启；一直免打扰时为 Number.MAX_SAFE_INTEGER */
  dndUntil: number
  frequency: Frequency
  /** 安静时段：这段时间内不主动说话（小动作也不做） */
  quietHours: { enabled: boolean, start: string, end: string }
  /** 各个时机是否开启 */
  triggers: Record<TriggerId, boolean>
  /** 午饭、晚饭、深夜提醒的时间，HH:mm */
  lunchTime: string
  dinnerTime: string
  lateNightTime: string
  /** 连续专注多少分钟后提醒活动一下 */
  focusMinutes: number
  /** 是否把前台窗口的标题发送给模型（标题中可能有文件名、网页标题等隐私信息） */
  shareWindowTitle: boolean
  /** 前台窗口全屏时（游戏、视频、演示）不打扰 */
  respectFullscreen: boolean
}

export const DND_FOREVER = Number.MAX_SAFE_INTEGER

export const DEFAULT_SETTINGS: ProactiveSettings = {
  enabled: true,
  dndUntil: 0,
  frequency: 'normal',
  quietHours: { enabled: false, start: '00:30', end: '07:30' },
  triggers: Object.fromEntries(TRIGGERS.map((trigger) => [trigger.id, true])) as Record<TriggerId, boolean>,
  lunchTime: '12:00',
  dinnerTime: '18:30',
  lateNightTime: '23:30',
  focusMinutes: 90,
  shareWindowTitle: false,
  respectFullscreen: true,
}

/** 读取保存的设置：新增的设置项与时机使用默认值 */
export function mergeSettings(stored: Partial<ProactiveSettings>, defaults = DEFAULT_SETTINGS): ProactiveSettings {
  return {
    ...defaults,
    ...stored,
    quietHours: { ...defaults.quietHours, ...stored.quietHours },
    triggers: { ...defaults.triggers, ...stored.triggers },
  }
}

/** 主动说过的一句话，交给模型避免重复 */
export interface SpokenLine {
  at: number
  trigger: TriggerId
  text: string
}

/** 主动交互的运行状态（保存在本地，重启后继续计算频率与冷却） */
export interface ProactiveState {
  /** 当前是哪一天（以凌晨 5 点为一天的开始），变化时重置每日的计数 */
  day: string
  /** 今天已经处理过的每日时机（说过话，或者模型判断不说） */
  handledToday: TriggerId[]
  /** 今天主动说话的次数 */
  spokenToday: number
  /** 最近一次主动说话的时间 */
  lastSpokeAt: number
  /** 冷却：键 → 冷却结束的时间 */
  cooldowns: Record<string, number>
  /** 连续几次主动说话后用户都没有回应，据此拉长间隔 */
  ignoredStreak: number
  /** 等待用户回应到什么时候，0 表示没有在等 */
  awaitingReplyUntil: number
  /** 已经提醒过的那段专注：开始时间与提醒的次数 */
  focusNotified: { since: number, count: number } | null
  /** 今天主动说过的话（最近几条） */
  recentLines: SpokenLine[]
}

export function createState(day = ''): ProactiveState {
  return {
    day,
    handledToday: [],
    spokenToday: 0,
    lastSpokeAt: 0,
    cooldowns: {},
    ignoredStreak: 0,
    awaitingReplyUntil: 0,
    focusNotified: null,
    recentLines: [],
  }
}

export type ProactiveOutcome = 'blocked' | 'declined' | 'spoke' | 'animated' | 'failed'

export const OUTCOME_LABELS: Record<ProactiveOutcome, string> = {
  blocked: '被拦下',
  declined: '决定不说',
  spoke: '说了话',
  animated: '做了小动作',
  failed: '出错',
}

/** 一次主动交互的记录，在设置中查看「为什么说了 / 为什么没说」 */
export interface ProactiveLogEntry {
  at: number
  trigger: TriggerId
  outcome: ProactiveOutcome
  /** 被拦下的原因、模型给出的理由，或者错误信息 */
  reason: string
  /** 说了什么 */
  text?: string
}
