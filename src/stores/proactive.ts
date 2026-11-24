import type { ActivitySnapshot, ActivityState } from '@/proactive/activity'
import type { DialogLine } from '@/proactive/judge'
import type { ProactiveLogEntry, ProactiveSettings, ProactiveState, TriggerId } from '@/proactive/types'
import { invoke } from '@tauri-apps/api/core'
import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { isTauri } from '@/composables/desktop'
import { ActivityTracker } from '@/proactive/activity'
import { ProactiveEngine } from '@/proactive/engine'
import { judgeProactive } from '@/proactive/judge'
import { proactiveSkills } from '@/proactive/skills'
import { createState, DEFAULT_SETTINGS, DND_FOREVER, mergeSettings } from '@/proactive/types'
import { useAgentStore } from '@/stores/agent'
import { useChatStore } from '@/stores/chat'
import { useLive2dStore } from '@/stores/live2d'
import { usePersonaStore } from '@/stores/persona'
import { useProvidersStore } from '@/stores/providers'
import { resolveLanguageModel } from '@/utils/llm'

// 检查时机的间隔
const TICK_INTERVAL = 30_000
// 查询用户活动状态的间隔（只在桌面应用中）
const ACTIVITY_INTERVAL = 5_000
// 启动后等一会儿再第一次检查（等模型、会话加载完）
const FIRST_TICK_DELAY = 8_000
// 主动交互的记录最多保留的条数
const MAX_LOG = 50
// 判断要不要说的超时时间
const JUDGE_TIMEOUT = 60_000
// 小动作（表情）持续的时间
const ANIMATION_DURATION = 4000
// 交给判断模块的最近对话条数
const RECENT_DIALOG = 4

/** 下一个早上 8 点（免打扰「到明天早上」） */
function nextMorning(now: number): number {
  const date = new Date(now)
  date.setHours(8, 0, 0, 0)
  if (date.getTime() <= now) date.setDate(date.getDate() + 1)
  return date.getTime()
}

export type DndOption = 'hour' | 'morning' | 'forever' | 'off'

// 主动交互：在合适的时机主动和用户说话，或者做个小动作
export const useProactiveStore = defineStore('proactive', () => {
  const chatStore = useChatStore()
  const agentStore = useAgentStore()
  const personaStore = usePersonaStore()
  const providersStore = useProvidersStore()
  const live2dStore = useLive2dStore()

  const settings = useLocalStorage<ProactiveSettings>('settings/proactive', DEFAULT_SETTINGS, {
    mergeDefaults: (stored, defaults) => mergeSettings(stored, defaults),
  })
  const state = useLocalStorage<ProactiveState>('proactive/state', createState(), { mergeDefaults: true })
  const log = useLocalStorage<ProactiveLogEntry[]>('proactive/log', [])

  // 用户的活动状态（只在桌面应用中能获取到）
  const activity = ref<ActivityState | null>(null)
  const tracker = new ActivityTracker()
  // 界面上显示免打扰剩余时间等用的时钟
  const clock = ref(Date.now())
  // 正在「试一下」
  const testing = ref(false)

  const dndActive = computed(() => settings.value.dndUntil > clock.value)

  const assistantName = () => personaStore.currentPersona?.name || '桌宠'
  // 主动交互可以使用的技能：只保留读取信息的工具
  const availableSkills = () => proactiveSkills(agentStore.activeSkills)

  // 判断要不要说：用意图识别的小模型，没有单独配置时用对话模型
  function judgeModel() {
    const routerModel = agentStore.resolveRouterModel()
    if (routerModel) return routerModel
    const provider = providersStore.getCurrentLLMProvider()
    if (!provider) throw new Error('未配置可用的 LLM Provider')
    return resolveLanguageModel(provider)
  }

  function recentDialog(): DialogLine[] {
    return chatStore.visibleMessages
      .filter((message) => message.content.trim())
      .slice(-RECENT_DIALOG)
      .map((message) => ({ role: message.role === 'user' ? 'user' : 'assistant', content: message.content }))
  }

  const engine = new ProactiveEngine({
    now: () => Date.now(),
    random: Math.random,
    settings: () => settings.value,
    state: () => state.value,
    activity: () => activity.value,
    conversation: () => ({
      busy: chatStore.isStreaming || !!chatStore.pendingPermission || !!chatStore.pendingQuestion,
      lastUserMessageAt: chatStore.lastUserMessageAt,
      recentDialog: recentDialog(),
    }),
    assistantName,
    judge: ({ trigger, situation, context }) => judgeProactive({
      model: judgeModel(),
      assistantName: assistantName(),
      trigger,
      situation,
      context,
      skills: availableSkills().map(({ id, name, description }) => ({ id, name, description })),
      abortSignal: AbortSignal.timeout(JUDGE_TIMEOUT),
    }),
    speak: ({ trigger, event, skills }) => chatStore.speakProactively(event, {
      label: trigger.label,
      skills: availableSkills().filter((skill) => skills.includes(skill.id)),
    }),
    animate: () => live2dStore.playRandomExpression(ANIMATION_DURATION),
    log: (entry) => {
      log.value = [entry, ...log.value].slice(0, MAX_LOG)
    },
  })

  // 用户发了消息：可能是在回应桌宠主动说的话
  watch(() => chatStore.lastUserMessageAt, () => engine.noteUserMessage())

  let activityWarned = false
  async function pollActivity() {
    try {
      const snapshot = await invoke<ActivitySnapshot>('activity_snapshot')
      const events = tracker.update(snapshot, Date.now())
      activity.value = tracker.state
      await engine.onActivityEvents(events)
    }
    catch (error) {
      if (!activityWarned) console.warn('[proactive] 获取用户活动状态失败：', error)
      activityWarned = true
    }
  }

  async function tick() {
    clock.value = Date.now()
    try {
      await engine.tick()
    }
    catch (error) {
      console.warn('[proactive] 检查主动交互的时机失败：', error)
    }
  }

  let started = false
  /** 开始运行：应用启动后调用一次 */
  function start() {
    if (started) return
    started = true
    if (isTauri) {
      void pollActivity()
      setInterval(pollActivity, ACTIVITY_INTERVAL)
    }
    setTimeout(() => {
      void tick()
      setInterval(tick, TICK_INTERVAL)
    }, FIRST_TICK_DELAY)
  }

  function setDnd(option: DndOption) {
    const now = Date.now()
    clock.value = now
    settings.value.dndUntil = {
      off: 0,
      hour: now + 60 * 60_000,
      morning: nextMorning(now),
      forever: DND_FOREVER,
    }[option]
  }

  /** 在设置中试一下某个时机（跳过时机开关、安静时段与频率限制） */
  async function tryNow(trigger: TriggerId) {
    testing.value = true
    try {
      return await engine.tryNow(trigger)
    }
    finally {
      testing.value = false
    }
  }

  function clearLog() {
    log.value = []
  }

  return {
    settings,
    state,
    log,
    activity,
    clock,
    testing,
    dndActive,
    start,
    setDnd,
    tryNow,
    clearLog,
  }
})
