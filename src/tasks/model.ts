// 待办任务的数据结构与查询、展示用的纯函数

export type TaskPriority = 'low' | 'normal' | 'high'
export type TaskRecurrence = 'daily' | 'weekdays' | 'weekly' | 'monthly'

export interface Task {
  id: string
  title: string
  notes?: string
  /** 截止时间，毫秒时间戳；只有日期时为当天 0 点 */
  due?: number
  /** 截止时间是否包含具体时刻 */
  dueHasTime?: boolean
  priority: TaskPriority
  tags: string[]
  /** 重复规则：完成后自动生成下一次的任务 */
  recurrence?: TaskRecurrence
  /** 提醒时间 */
  remindAt?: number
  /** 对应的提醒（由提醒功能负责到时提醒） */
  reminderId?: string
  done: boolean
  createdAt: number
  updatedAt: number
  completedAt?: number
}

export const PRIORITY_LABELS: Record<TaskPriority, string> = { high: '高', normal: '普通', low: '低' }
export const RECURRENCE_LABELS: Record<TaskRecurrence, string> = {
  daily: '每天',
  weekdays: '每个工作日',
  weekly: '每周',
  monthly: '每月',
}

const DAY = 24 * 60 * 60 * 1000
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function startOfDay(time: number | Date): number {
  const date = new Date(time)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function addDays(time: number, days: number): number {
  const date = new Date(time)
  date.setDate(date.getDate() + days)
  return date.getTime()
}

/** 本周一 0 点 */
function startOfWeek(now: Date): number {
  const day = now.getDay() || 7
  return addDays(startOfDay(now), 1 - day)
}

/** 解析 YYYY-MM-DD 或 YYYY-MM-DD HH:mm */
export function parseDue(text: string): { due: number, hasTime: boolean } | undefined {
  const match = text.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?$/)
  if (!match) return undefined
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const hasTime = match[4] !== undefined
  const date = new Date(year, month - 1, day, hasTime ? Number(match[4]) : 0, hasTime ? Number(match[5]) : 0)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return undefined
  return { due: date.getTime(), hasTime }
}

/** 是否已逾期：有具体时刻的按时刻，只有日期的过了当天才算 */
export function isOverdue(task: Task, now = Date.now()): boolean {
  if (task.done || task.due === undefined) return false
  return task.dueHasTime ? task.due < now : addDays(startOfDay(task.due), 1) <= now
}

/** 截止时间的可读形式，如「今天 15:00」「明天」「周三」「11月30日」 */
export function formatDue(task: Pick<Task, 'due' | 'dueHasTime'>, now = new Date()): string {
  if (task.due === undefined) return ''
  const date = new Date(task.due)
  const days = Math.round((startOfDay(date) - startOfDay(now)) / DAY)
  let label: string
  if (days === 0) label = '今天'
  else if (days === 1) label = '明天'
  else if (days === 2) label = '后天'
  else if (days === -1) label = '昨天'
  else if (days > 2 && days < 7 && startOfDay(date) < addDays(startOfWeek(now), 7)) label = WEEKDAYS[date.getDay()]!
  else if (date.getFullYear() === now.getFullYear()) label = `${date.getMonth() + 1}月${date.getDate()}日`
  else label = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`

  if (!task.dueHasTime) return label
  return `${label} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** 重复任务的下一次截止时间 */
export function nextOccurrence(due: number, recurrence: TaskRecurrence): number {
  const date = new Date(due)
  switch (recurrence) {
    case 'daily':
      return addDays(due, 1)
    case 'weekly':
      return addDays(due, 7)
    case 'weekdays': {
      let next = addDays(due, 1)
      while ([0, 6].includes(new Date(next).getDay())) next = addDays(next, 1)
      return next
    }
    case 'monthly': {
      // 下个月的同一天，没有这一天时（如 31 号）取月末
      const target = new Date(date.getFullYear(), date.getMonth() + 1, 1, date.getHours(), date.getMinutes())
      const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
      target.setDate(Math.min(date.getDate(), lastDay))
      return target.getTime()
    }
  }
}

export type TaskRange = 'all' | 'overdue' | 'today' | 'tomorrow' | 'week' | 'upcoming' | 'nodue'

export interface TaskFilter {
  status?: 'todo' | 'done' | 'all'
  /** overdue 逾期；today 今天；tomorrow 明天；week 本周（周一至周日）；upcoming 未来 7 天（含今天）；nodue 没有截止时间 */
  range?: TaskRange
  tag?: string
  keyword?: string
}

function inRange(task: Task, range: TaskRange, now: Date): boolean {
  if (range === 'all') return true
  if (range === 'nodue') return task.due === undefined
  if (task.due === undefined) return false
  if (range === 'overdue') return isOverdue(task, now.getTime())

  const today = startOfDay(now)
  const [start, end] = {
    today: [today, addDays(today, 1)],
    tomorrow: [addDays(today, 1), addDays(today, 2)],
    week: [startOfWeek(now), addDays(startOfWeek(now), 7)],
    upcoming: [today, addDays(today, 7)],
  }[range]
  return task.due >= start! && task.due < end!
}

const PRIORITY_ORDER: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 }

/** 排序：未完成的在前（截止时间早的在前，没有截止时间的在后，同一时间高优先级在前）；已完成的按完成时间从新到旧 */
export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1
    if (a.done) return (b.completedAt ?? 0) - (a.completedAt ?? 0)
    const dueA = a.due ?? Number.POSITIVE_INFINITY
    const dueB = b.due ?? Number.POSITIVE_INFINITY
    return dueA - dueB || PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.createdAt - b.createdAt
  })
}

export function filterTasks(tasks: Task[], filter: TaskFilter = {}, now = new Date()): Task[] {
  const status = filter.status ?? 'todo'
  const keyword = filter.keyword?.trim().toLowerCase()
  const tag = filter.tag?.trim().replace(/^#/, '').toLowerCase()
  return sortTasks(tasks.filter((task) =>
    (status === 'all' || task.done === (status === 'done'))
    && inRange(task, filter.range ?? 'all', now)
    && (!tag || task.tags.some((t) => t.toLowerCase() === tag))
    && (!keyword || `${task.title} ${task.notes ?? ''}`.toLowerCase().includes(keyword)),
  ))
}
