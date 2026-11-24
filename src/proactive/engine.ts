import type { ActivityEvent, ActivityState } from '@/proactive/activity'
import type { ConversationState } from '@/proactive/gate'
import type { DialogLine, ProactiveDecision } from '@/proactive/judge'
import type { ProactiveCandidate } from '@/proactive/triggers'
import type { ProactiveLogEntry, ProactiveOutcome, ProactiveSettings, ProactiveState, TriggerId, TriggerInfo } from '@/proactive/types'
import { errorMessage, truncate } from '@/agent/utils'
import { checkGate } from '@/proactive/gate'
import { buildSpeakEvent, describeContext } from '@/proactive/judge'
import { dayKey, eventCandidate, focusCandidate, spontaneousCandidates, timeCandidates } from '@/proactive/triggers'
import { FREQUENCY_PRESETS, triggerInfo } from '@/proactive/types'

/**
 * 主动交互的编排：收集时机 → 本地筛选 → 模型判断 → 生成并说出来，并记录结果、维护频率与冷却。
 * 依赖（时钟、随机数、模型、说话、做动作）都由外部注入，便于测试；store 负责接上真实的实现。
 */

export interface JudgeRequest {
  trigger: TriggerInfo
  situation: string
  context: string
}

export interface SpeakRequest {
  trigger: TriggerInfo
  /** 交给角色扮演阶段的事件说明 */
  event: string
  /** 获取信息需要的技能 id */
  skills: string[]
}

export interface EngineDeps {
  now: () => number
  random: () => number
  settings: () => ProactiveSettings
  /** 运行状态，由引擎直接修改（store 中是会保存到本地的响应式对象） */
  state: () => ProactiveState
  activity: () => ActivityState | null
  conversation: () => ConversationState & { recentDialog: DialogLine[] }
  assistantName: () => string
  judge: (request: JudgeRequest) => Promise<ProactiveDecision>
  /** 说出来，返回说了什么；失败时返回空字符串 */
  speak: (request: SpeakRequest) => Promise<string>
  animate: () => void
  log: (entry: ProactiveLogEntry) => void
}

const MINUTE = 60_000
/** 主动说话后等待用户回应的时间：这段时间内用户发了消息就算有回应 */
export const REPLY_WINDOW_MS = 10 * MINUTE
/** 连续被忽略的次数最多记到几次（间隔最多拉长到 8 倍） */
const MAX_IGNORED = 3
/** 记住今天主动说过的最近几句话 */
const RECENT_LINES = 5
/** 两次检查之间的时间最多按多久算（电脑睡眠后醒来时，不要一下子触发很多自发交互） */
const MAX_TICK_GAP = 10 * MINUTE

type HandleResult = ProactiveOutcome | 'busy' | 'cooling'

export class ProactiveEngine {
  private running = false
  private lastTickAt: number | null = null
  /** 每个时机最近一次被拦下的原因：时间窗口内每次检查都可能被拦下，同样的原因不重复记录 */
  private readonly lastBlocked = new Map<TriggerId, string>()

  constructor(private readonly deps: EngineDeps) {}

  /** 是否正在判断或生成 */
  get busy(): boolean {
    return this.running
  }

  /** 定时调用：检查时间、上下文与自发的时机，每次最多处理一个 */
  async tick(): Promise<void> {
    const now = this.deps.now()
    this.rollover(now)
    this.settleFeedback(now)
    const elapsed = this.lastTickAt === null ? 0 : Math.min(Math.max(0, now - this.lastTickAt), MAX_TICK_GAP)
    this.lastTickAt = now

    const settings = this.deps.settings()
    const state = this.deps.state()
    const activity = this.deps.activity()
    const focus = focusCandidate(now, settings, state, activity)
    await this.handleFirst([
      ...timeCandidates(now, settings, state, activity),
      ...(focus ? [focus] : []),
      ...spontaneousCandidates(this.deps.random, elapsed, FREQUENCY_PRESETS[settings.frequency].spontaneousScale),
    ])
  }

  /** 活动状态变化产生的事件（回到电脑前、切换应用） */
  async onActivityEvents(events: ActivityEvent[]): Promise<void> {
    if (events.length === 0) return
    this.rollover(this.deps.now())
    await this.handleFirst(events.map(eventCandidate))
  }

  /** 用户发了消息：在等待回应的时间内发的，就算回应了主动说的话 */
  noteUserMessage(): void {
    const state = this.deps.state()
    if (state.awaitingReplyUntil && this.deps.now() <= state.awaitingReplyUntil) {
      state.ignoredStreak = 0
      state.awaitingReplyUntil = 0
    }
  }

  /** 在设置中「试一下」某个时机：跳过时机开关、安静时段与频率限制 */
  async tryNow(id: TriggerId): Promise<HandleResult> {
    this.rollover(this.deps.now())
    const trigger = triggerInfo(id)
    return this.handle({ trigger: id, situation: `${trigger.description}（用户在设置中点了「试一下」）` }, true)
  }

  private async handleFirst(candidates: ProactiveCandidate[]) {
    for (const candidate of candidates) {
      const result = await this.handle(candidate)
      if (result === 'busy') return
      if (result !== 'blocked' && result !== 'cooling') return
    }
  }

  private async handle(candidate: ProactiveCandidate, force = false): Promise<HandleResult> {
    const { deps } = this
    if (this.running) return 'busy'
    const now = deps.now()
    const state = deps.state()
    const settings = deps.settings()
    const trigger = triggerInfo(candidate.trigger)
    if (!force && candidate.cooldown && (state.cooldowns[candidate.cooldown.key] ?? 0) > now) return 'cooling'

    const activity = deps.activity()
    const conversation = deps.conversation()
    const gate = checkGate(trigger, { now, settings, state, activity, conversation, force })
    if (!gate.ok) {
      // 小动作很频繁，被拦下时不记录
      if (trigger.kind === 'speech' && this.lastBlocked.get(trigger.id) !== gate.reason) {
        deps.log({ at: now, trigger: trigger.id, outcome: 'blocked', reason: gate.reason })
      }
      this.lastBlocked.set(trigger.id, gate.reason)
      return 'blocked'
    }
    this.lastBlocked.delete(trigger.id)

    if (trigger.kind === 'animation') {
      deps.animate()
      return 'animated'
    }

    this.running = true
    try {
      // 先记下处理过，判断或生成失败也不会马上重试
      this.markHandled(candidate, now)
      const contextInput = { now, activity, shareWindowTitle: settings.shareWindowTitle, state, assistantName: deps.assistantName() }
      const decision = await deps.judge({
        trigger,
        situation: candidate.situation,
        context: describeContext({ ...contextInput, recentDialog: conversation.recentDialog }),
      })
      if (!decision.speak) {
        deps.log({ at: now, trigger: trigger.id, outcome: 'declined', reason: decision.reason || '模型判断现在不说' })
        return 'declined'
      }

      const text = await deps.speak({
        trigger,
        event: buildSpeakEvent(trigger, candidate.situation, decision.intent, describeContext(contextInput)),
        skills: decision.skills,
      })
      if (!text.trim()) {
        deps.log({ at: now, trigger: trigger.id, outcome: 'failed', reason: '没有生成内容（可以在对话框中查看错误）' })
        return 'failed'
      }

      const spokeAt = deps.now()
      state.spokenToday++
      state.lastSpokeAt = spokeAt
      state.awaitingReplyUntil = spokeAt + REPLY_WINDOW_MS
      state.recentLines = [...state.recentLines, { at: spokeAt, trigger: trigger.id, text: truncate(text.trim(), 200) }].slice(-RECENT_LINES)
      deps.log({ at: now, trigger: trigger.id, outcome: 'spoke', reason: decision.reason, text: text.trim() })
      return 'spoke'
    }
    catch (error) {
      deps.log({ at: now, trigger: trigger.id, outcome: 'failed', reason: errorMessage(error) })
      return 'failed'
    }
    finally {
      this.running = false
    }
  }

  private markHandled(candidate: ProactiveCandidate, now: number) {
    const state = this.deps.state()
    if (candidate.daily && !state.handledToday.includes(candidate.trigger)) state.handledToday = [...state.handledToday, candidate.trigger]
    if (candidate.cooldown) state.cooldowns = { ...state.cooldowns, [candidate.cooldown.key]: now + candidate.cooldown.ms }
    if (candidate.focus) state.focusNotified = candidate.focus
  }

  /** 新的一天：重置每日的计数，清理过期的冷却 */
  private rollover(now: number) {
    const state = this.deps.state()
    const today = dayKey(now)
    if (state.day === today) return
    state.day = today
    state.handledToday = []
    state.spokenToday = 0
    state.recentLines = []
    state.cooldowns = Object.fromEntries(Object.entries(state.cooldowns).filter(([, until]) => until > now))
    this.lastBlocked.clear()
  }

  /** 等待回应的时间过了还没有回应：算作被忽略一次 */
  private settleFeedback(now: number) {
    const state = this.deps.state()
    if (state.awaitingReplyUntil && now > state.awaitingReplyUntil) {
      state.ignoredStreak = Math.min(state.ignoredStreak + 1, MAX_IGNORED)
      state.awaitingReplyUntil = 0
    }
  }
}
