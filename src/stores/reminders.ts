import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'

export interface Reminder {
  id: string
  /** 提醒内容 */
  message: string
  /** 到期时间戳 */
  dueAt: number
  createdAt: number
}

export interface DueReminder extends Reminder {
  /** 到期时应用未在运行，重新打开后才补发的提醒 */
  late: boolean
}

// setTimeout 的最大延迟（约 24.8 天），更久的提醒分段等待
const MAX_TIMEOUT = 2 ** 31 - 1
// 超过到期时间这么久才触发的提醒视为错过
const LATE_THRESHOLD = 60 * 1000

function createReminderId(): string {
  return Math.random().toString(36).slice(2, 8)
}

// 提醒事项：持久化保存，到期时通知订阅方（由 chat store 让桌宠主动开口提醒）
export const useRemindersStore = defineStore('reminders', () => {
  const reminders = useLocalStorage<Reminder[]>('agent/reminders', [])
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const onDueHooks: ((reminder: DueReminder) => Promise<void>)[] = []

  function schedule(reminder: Reminder) {
    clearTimeout(timers.get(reminder.id))
    const delay = Math.max(0, reminder.dueAt - Date.now())
    const timer = setTimeout(() => {
      if (delay > MAX_TIMEOUT) schedule(reminder)
      else fire(reminder.id)
    }, Math.min(delay, MAX_TIMEOUT))
    timers.set(reminder.id, timer)
  }

  function fire(id: string) {
    const index = reminders.value.findIndex((r) => r.id === id)
    timers.delete(id)
    if (index === -1) return

    const [reminder] = reminders.value.splice(index, 1)
    const due: DueReminder = { ...reminder!, late: Date.now() - reminder!.dueAt > LATE_THRESHOLD }
    onDueHooks.forEach((hook) => hook(due))
  }

  function addReminder(message: string, dueAt: number): Reminder {
    let id = createReminderId()
    while (reminders.value.some((r) => r.id === id)) id = createReminderId()

    const reminder: Reminder = { id, message, dueAt, createdAt: Date.now() }
    reminders.value.push(reminder)
    reminders.value.sort((a, b) => a.dueAt - b.dueAt)
    schedule(reminder)
    return reminder
  }

  function cancelReminder(id: string): Reminder | undefined {
    const index = reminders.value.findIndex((r) => r.id === id)
    if (index === -1) return undefined
    clearTimeout(timers.get(id))
    timers.delete(id)
    return reminders.value.splice(index, 1)[0]
  }

  function onDue(hook: (reminder: DueReminder) => Promise<void>) {
    onDueHooks.push(hook)
  }

  // 恢复上次运行时未到期的提醒；已过期的会在下一轮事件循环中立即触发，
  // 此时订阅方已在 store 创建后同步完成注册
  reminders.value.forEach(schedule)

  return {
    reminders,
    addReminder,
    cancelReminder,
    onDue,
  }
})
