import type { PermissionRequest } from '@/agent/types'
import type { Task } from '@/tasks/model'
import { MockLanguageModelV3 } from 'ai/test'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAgent } from '@/agent'
import { tasksSkill } from '@/agent/skills/tasks'
import { useRemindersStore } from '@/stores/reminders'
import { useTasksStore } from '@/stores/tasks'
import { filterTasks, formatDue, isOverdue, nextOccurrence, parseDue, sortTasks } from '@/tasks/model'

// 2026-11-25 星期三 10:00
const NOW = new Date(2026, 10, 25, 10, 0)
const at = (...args: [number, number, number, number?, number?]) => new Date(args[0], args[1] - 1, args[2], args[3] ?? 0, args[4] ?? 0).getTime()

function task(patch: Partial<Task>): Task {
  return { id: Math.random().toString(36), title: '任务', priority: 'normal', tags: [], done: false, createdAt: 0, updatedAt: 0, ...patch }
}

describe('待办的时间', () => {
  it('解析截止时间', () => {
    expect(parseDue('2026-11-26')).toEqual({ due: at(2026, 11, 26), hasTime: false })
    expect(parseDue('2026-11-26 15:30')).toEqual({ due: at(2026, 11, 26, 15, 30), hasTime: true })
    expect(parseDue('2026-02-30')).toBeUndefined()
    expect(parseDue('明天')).toBeUndefined()
  })

  it('判断逾期：只有日期的过了当天才算', () => {
    const now = NOW.getTime()
    expect(isOverdue(task({ due: at(2026, 11, 25), dueHasTime: false }), now)).toBe(false)
    expect(isOverdue(task({ due: at(2026, 11, 24), dueHasTime: false }), now)).toBe(true)
    expect(isOverdue(task({ due: at(2026, 11, 25, 9), dueHasTime: true }), now)).toBe(true)
    expect(isOverdue(task({ due: at(2026, 11, 24), done: true }), now)).toBe(false)
  })

  it('显示截止时间', () => {
    expect(formatDue({ due: at(2026, 11, 25, 15), dueHasTime: true }, NOW)).toBe('今天 15:00')
    expect(formatDue({ due: at(2026, 11, 26), dueHasTime: false }, NOW)).toBe('明天')
    expect(formatDue({ due: at(2026, 11, 28), dueHasTime: false }, NOW)).toBe('周六')
    expect(formatDue({ due: at(2026, 12, 3), dueHasTime: false }, NOW)).toBe('12月3日')
    expect(formatDue({ due: at(2027, 1, 3), dueHasTime: false }, NOW)).toBe('2027年1月3日')
  })

  it('计算重复任务的下一次时间', () => {
    expect(nextOccurrence(at(2026, 11, 25, 9), 'daily')).toBe(at(2026, 11, 26, 9))
    expect(nextOccurrence(at(2026, 11, 25), 'weekly')).toBe(at(2026, 12, 2))
    // 周五的下一个工作日是周一
    expect(nextOccurrence(at(2026, 11, 27), 'weekdays')).toBe(at(2026, 11, 30))
    // 1 月 31 日的下个月没有 31 号，取月末
    expect(nextOccurrence(at(2026, 1, 31, 8), 'monthly')).toBe(at(2026, 2, 28, 8))
  })
})

describe('筛选与排序', () => {
  const tasks = [
    task({ id: 'nodue', title: '读书' }),
    task({ id: 'today', title: '交周报', due: at(2026, 11, 25, 18), dueHasTime: true, tags: ['工作'] }),
    task({ id: 'overdue', title: '回邮件', due: at(2026, 11, 23), priority: 'high' }),
    task({ id: 'nextweek', title: '体检', due: at(2026, 12, 1) }),
    task({ id: 'done', title: '买菜', done: true, completedAt: 5 }),
  ]
  const ids = (list: Task[]) => list.map((item) => item.id)

  it('按截止时间排序，没有截止时间的在后，已完成的最后', () => {
    expect(ids(sortTasks(tasks))).toEqual(['overdue', 'today', 'nextweek', 'nodue', 'done'])
  })

  it('按状态、时间范围、标签与关键词筛选', () => {
    expect(ids(filterTasks(tasks, {}, NOW))).toEqual(['overdue', 'today', 'nextweek', 'nodue'])
    expect(ids(filterTasks(tasks, { range: 'today' }, NOW))).toEqual(['today'])
    expect(ids(filterTasks(tasks, { range: 'overdue' }, NOW))).toEqual(['overdue'])
    expect(ids(filterTasks(tasks, { range: 'week' }, NOW))).toEqual(['overdue', 'today'])
    expect(ids(filterTasks(tasks, { range: 'upcoming' }, NOW))).toEqual(['today', 'nextweek'])
    expect(ids(filterTasks(tasks, { range: 'nodue' }, NOW))).toEqual(['nodue'])
    expect(ids(filterTasks(tasks, { tag: '#工作' }, NOW))).toEqual(['today'])
    expect(ids(filterTasks(tasks, { keyword: '邮件' }, NOW))).toEqual(['overdue'])
    expect(ids(filterTasks(tasks, { status: 'done' }, NOW))).toEqual(['done'])
  })
})

describe('待办 store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    localStorage.clear()
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('设置了提醒时间的任务会创建提醒，完成后取消提醒', () => {
    const store = useTasksStore()
    const reminders = useRemindersStore()
    const created = store.createTask({ title: ' 交周报 ', due: at(2026, 11, 25, 18), dueHasTime: true, remindAt: at(2026, 11, 25, 17), tags: ['#工作', '工作'] })

    expect(created.title).toBe('交周报')
    expect(created.tags).toEqual(['工作'])
    expect(reminders.reminders).toMatchObject([{ id: created.reminderId, message: '待办：交周报', dueAt: at(2026, 11, 25, 17) }])

    store.completeTask(created.id)
    expect(reminders.reminders).toEqual([])
  })

  it('完成重复的任务时生成下一次，提醒时间随之顺延', () => {
    const store = useTasksStore()
    const weekly = store.createTask({ title: '开例会', due: at(2026, 11, 23, 10), dueHasTime: true, recurrence: 'weekly', remindAt: at(2026, 11, 30, 9, 50) })
    const { task, next } = store.completeTask(weekly.id)

    expect(task.done).toBe(true)
    expect(next).toMatchObject({ title: '开例会', due: at(2026, 11, 30, 10), dueHasTime: true, recurrence: 'weekly', remindAt: at(2026, 12, 7, 9, 50), done: false })
  })

  it('以前单独设置的提醒转为待办任务，沿用原来的提醒', () => {
    const reminders = useRemindersStore()
    const old = reminders.addReminder('喝水', at(2026, 11, 25, 10, 30))
    const store = useTasksStore()

    expect(store.tasks).toMatchObject([{ title: '喝水', remindAt: at(2026, 11, 25, 10, 30), reminderId: old.id, done: false }])
    expect(reminders.reminders).toHaveLength(1)

    // 完成任务时取消这个提醒
    store.completeTask(store.tasks[0]!.id)
    expect(reminders.reminders).toEqual([])
  })

  it('修改与删除任务', () => {
    const store = useTasksStore()
    const created = store.createTask({ title: '体检', due: at(2026, 12, 2) })
    const updated = store.updateTask(created.id, { due: null, priority: 'high', notes: '空腹' })
    expect(updated).toMatchObject({ priority: 'high', notes: '空腹' })
    expect(updated.due).toBeUndefined()

    expect(() => store.updateTask(created.id, { title: '  ' })).toThrow('不能为空')
    expect(store.deleteTasks([created.id]).map((item) => item.title)).toEqual(['体检'])
    expect(store.tasks).toEqual([])
  })
})

describe('待办技能', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    localStorage.clear()
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function call(toolName: string, input: unknown, requestPermission?: (request: PermissionRequest) => Promise<boolean>) {
    return runAgent({
      model: new MockLanguageModelV3(),
      messages: [{ role: 'user', content: '待办' }],
      skills: [tasksSkill],
      directCall: { skillId: 'tasks', toolName, input },
      requestPermission,
    })
  }

  it('创建、查询、修改与完成任务', async () => {
    const created = await call('create_task', { title: '交周报', due: '2026-11-25 18:00', remindAt: '2026-11-25 17:30', tags: ['工作'] })
    expect(created?.toolCalls[0]?.output).toMatchObject({ created: { title: '交周报', due: '今天 18:00', remind: '今天 17:30' } })

    const id = useTasksStore().tasks[0]!.id
    const listed = await call('list_tasks', { range: 'today' })
    expect(listed?.toolCalls[0]?.output).toMatchObject({ count: 1, tasks: [{ id, title: '交周报' }] })

    const updated = await call('update_task', { id, due: '2026-11-27', remindAt: 'none' })
    expect(updated?.toolCalls[0]?.output).toMatchObject({ updated: { due: '后天' } })
    expect(useTasksStore().tasks[0]!.remindAt).toBeUndefined()

    await call('complete_task', { ids: [id] })
    expect(useTasksStore().tasks[0]!.done).toBe(true)
  })

  it('按相对时间设置提醒，取消提醒', async () => {
    const created = await call('create_task', { title: '喝水', remindInMinutes: 10 })
    expect(created?.toolCalls[0]?.output).toMatchObject({ created: { title: '喝水', remind: '今天 10:10' } })
    const task = useTasksStore().tasks[0]!
    expect(useRemindersStore().reminders).toMatchObject([{ id: task.reminderId, dueAt: at(2026, 11, 25, 10, 10) }])

    await call('update_task', { id: task.id, remindAt: 'none' })
    expect(useRemindersStore().reminders).toEqual([])

    const both = await call('create_task', { title: '喝水', remindAt: '2026-11-25 11:00', remindInMinutes: 10 })
    expect(both?.toolCalls[0]?.error).toContain('只能填写一个')
  })

  it('时间格式不正确或提醒时间已过时报错', async () => {
    expect((await call('create_task', { title: '体检', due: '下周三' }))?.toolCalls[0]?.error).toContain('无法识别的时间')
    expect((await call('create_task', { title: '体检', remindAt: '2026-11-25' }))?.toolCalls[0]?.error).toContain('具体到时刻')
    expect((await call('create_task', { title: '体检', remindAt: '2026-11-24 10:00' }))?.toolCalls[0]?.error).toContain('已经过去')
  })

  it('删除任务前请求确认', async () => {
    const store = useTasksStore()
    const created = store.createTask({ title: '买菜' })
    const requests: PermissionRequest[] = []

    await call('delete_tasks', { ids: [created.id], reason: '用户说不用买了' }, async (request) => {
      requests.push(request)
      return false
    })
    expect(store.tasks).toHaveLength(1)
    expect(requests[0]).toMatchObject({ kind: 'tasks-delete', target: '· 买菜' })

    await call('delete_tasks', { ids: [created.id], reason: '用户说不用买了' }, async () => true)
    expect(store.tasks).toHaveLength(0)
  })
})
