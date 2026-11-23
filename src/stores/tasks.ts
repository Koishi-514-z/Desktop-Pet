import type { Task, TaskPriority, TaskRecurrence } from '@/tasks/model'
import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed } from 'vue'
import { useRemindersStore } from '@/stores/reminders'
import { isOverdue, nextOccurrence, sortTasks, startOfDay } from '@/tasks/model'

export interface TaskInput {
  title: string
  notes?: string
  /** 截止时间；null 表示清除 */
  due?: number | null
  dueHasTime?: boolean
  priority?: TaskPriority
  tags?: string[]
  /** 重复规则；null 表示清除 */
  recurrence?: TaskRecurrence | null
  /** 提醒时间；null 表示清除 */
  remindAt?: number | null
}

function createTaskId(): string {
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function normalizeTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((tag) => tag.trim().replace(/^#/, '')).filter(Boolean))]
}

// 待办任务：保存在本地，设置了提醒时间的任务会由提醒功能到时提醒
export const useTasksStore = defineStore('tasks', () => {
  const remindersStore = useRemindersStore()
  const tasks = useLocalStorage<Task[]>('tasks/items', [])

  const pending = computed(() => sortTasks(tasks.value.filter((task) => !task.done)))
  const overdueCount = computed(() => pending.value.filter((task) => isOverdue(task)).length)

  function find(id: string): Task {
    const task = tasks.value.find((item) => item.id === id)
    if (!task) throw new Error(`找不到 id 为 ${id} 的任务`)
    return task
  }

  /** 让提醒与任务保持一致：已完成、没有提醒时间或提醒时间已过时取消提醒 */
  function syncReminder(task: Task) {
    if (task.reminderId) {
      remindersStore.cancelReminder(task.reminderId)
      delete task.reminderId
    }
    if (!task.done && task.remindAt && task.remindAt > Date.now()) {
      task.reminderId = remindersStore.addReminder(`待办：${task.title}`, task.remindAt).id
    }
  }

  function createTask(input: TaskInput): Task {
    const title = input.title.trim()
    if (!title) throw new Error('任务内容不能为空')
    const now = Date.now()
    const task: Task = {
      id: createTaskId(),
      title,
      ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
      ...(input.due != null ? { due: input.due, dueHasTime: input.dueHasTime ?? false } : {}),
      priority: input.priority ?? 'normal',
      tags: normalizeTags(input.tags),
      ...(input.recurrence ? { recurrence: input.recurrence } : {}),
      ...(input.remindAt != null ? { remindAt: input.remindAt } : {}),
      done: false,
      createdAt: now,
      updatedAt: now,
    }
    syncReminder(task)
    tasks.value = [...tasks.value, task]
    return task
  }

  function updateTask(id: string, patch: Partial<TaskInput>): Task {
    const task = { ...find(id) }
    if (patch.title !== undefined) {
      if (!patch.title.trim()) throw new Error('任务内容不能为空')
      task.title = patch.title.trim()
    }
    if (patch.notes !== undefined) {
      if (patch.notes.trim()) task.notes = patch.notes.trim()
      else delete task.notes
    }
    if (patch.due === null) {
      delete task.due
      delete task.dueHasTime
    }
    else if (patch.due !== undefined) {
      task.due = patch.due
      task.dueHasTime = patch.dueHasTime ?? false
    }
    if (patch.priority) task.priority = patch.priority
    if (patch.tags) task.tags = normalizeTags(patch.tags)
    if (patch.recurrence === null) delete task.recurrence
    else if (patch.recurrence) task.recurrence = patch.recurrence
    if (patch.remindAt === null) delete task.remindAt
    else if (patch.remindAt !== undefined) task.remindAt = patch.remindAt
    task.updatedAt = Date.now()

    syncReminder(task)
    tasks.value = tasks.value.map((item) => (item.id === id ? task : item))
    return task
  }

  /** 完成任务；重复的任务会生成下一次 */
  function completeTask(id: string): { task: Task, next?: Task } {
    const current = find(id)
    if (current.done) return { task: current }
    const now = Date.now()
    const task: Task = { ...current, done: true, completedAt: now, updatedAt: now }
    syncReminder(task)
    tasks.value = tasks.value.map((item) => (item.id === id ? task : item))

    if (!task.recurrence) return { task }
    // 下一次的截止时间：从原截止时间（没有时从今天）往后推，跳过已经过去的时间
    const recurrence = task.recurrence
    let due = task.due ?? startOfDay(now)
    do {
      due = nextOccurrence(due, recurrence)
    } while (due < startOfDay(now))
    const shift = due - (task.due ?? due)
    const next = createTask({
      title: task.title,
      notes: task.notes,
      due,
      dueHasTime: task.due !== undefined ? task.dueHasTime : false,
      priority: task.priority,
      tags: task.tags,
      recurrence: task.recurrence,
      remindAt: task.remindAt !== undefined && task.due !== undefined ? task.remindAt + shift : undefined,
    })
    return { task, next }
  }

  function reopenTask(id: string): Task {
    const task: Task = { ...find(id), done: false, updatedAt: Date.now() }
    delete task.completedAt
    syncReminder(task)
    tasks.value = tasks.value.map((item) => (item.id === id ? task : item))
    return task
  }

  function deleteTasks(ids: string[]): Task[] {
    const removed = tasks.value.filter((task) => ids.includes(task.id))
    removed.forEach((task) => {
      if (task.reminderId) remindersStore.cancelReminder(task.reminderId)
    })
    tasks.value = tasks.value.filter((task) => !ids.includes(task.id))
    return removed
  }

  /** 清除所有已完成的任务 */
  function clearCompleted(): number {
    const done = tasks.value.filter((task) => task.done).map((task) => task.id)
    deleteTasks(done)
    return done.length
  }

  // 提醒统一由待办管理：以前单独设置的、没有对应任务的提醒转为只带提醒时间的任务，
  // 沿用原来的提醒，这样可以在待办中查看、修改与取消
  const linked = new Set(tasks.value.map((task) => task.reminderId))
  const orphans = remindersStore.reminders.filter((reminder) => !linked.has(reminder.id))
  if (orphans.length) {
    const now = Date.now()
    tasks.value = [...tasks.value, ...orphans.map((reminder): Task => ({
      id: createTaskId(),
      title: reminder.message,
      priority: 'normal',
      tags: [],
      remindAt: reminder.dueAt,
      reminderId: reminder.id,
      done: false,
      createdAt: reminder.createdAt,
      updatedAt: now,
    }))]
  }

  return {
    tasks,
    pending,
    overdueCount,
    createTask,
    updateTask,
    completeTask,
    reopenTask,
    deleteTasks,
    clearCompleted,
  }
})
