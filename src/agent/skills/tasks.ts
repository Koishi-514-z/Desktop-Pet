import type { Skill } from '@/agent/types'
import type { Task, TaskRecurrence } from '@/tasks/model'
import { tool } from 'ai'
import { z } from 'zod'
import { getSkillContext } from '@/agent/context'
import { useTasksStore } from '@/stores/tasks'
import { filterTasks, formatDue, isOverdue, parseDue, PRIORITY_LABELS, RECURRENCE_LABELS } from '@/tasks/model'

export const TASKS_SKILL_ID = 'tasks'

// 删除任务的权限类型
export const TASKS_DELETE_PERMISSION = 'tasks-delete'

const RECURRENCES = ['daily', 'weekdays', 'weekly', 'monthly'] as const

/** 解析截止时间参数：YYYY-MM-DD 或 YYYY-MM-DD HH:mm；none 表示清除 */
function dueInput(value: string | undefined) {
  if (value === undefined) return {}
  if (value === 'none') return { due: null }
  const parsed = parseDue(value)
  if (!parsed) throw new Error(`无法识别的时间：${value}，格式应为 YYYY-MM-DD 或 YYYY-MM-DD HH:mm`)
  return { due: parsed.due, dueHasTime: parsed.hasTime }
}

/** 解析提醒时间参数：具体时刻 remindAt 或相对时间 remindInMinutes（如「十分钟后」），二者只填一个 */
function remindInput(value: string | undefined, minutes: number | undefined) {
  if (value !== undefined && minutes !== undefined) throw new Error('remindAt 与 remindInMinutes 只能填写一个')
  if (minutes !== undefined) return { remindAt: Date.now() + minutes * 60_000 }
  if (value === undefined) return {}
  if (value === 'none') return { remindAt: null }
  const parsed = parseDue(value)
  if (!parsed?.hasTime) throw new Error(`提醒时间需要具体到时刻，格式为 YYYY-MM-DD HH:mm：${value}`)
  if (parsed.due <= Date.now()) throw new Error('提醒时间已经过去了')
  return { remindAt: parsed.due }
}

function describe(task: Task) {
  return {
    id: task.id,
    title: task.title,
    ...(task.notes ? { notes: task.notes } : {}),
    ...(task.due !== undefined ? { due: formatDue(task), overdue: isOverdue(task) } : {}),
    ...(task.priority !== 'normal' ? { priority: PRIORITY_LABELS[task.priority] } : {}),
    ...(task.tags.length ? { tags: task.tags } : {}),
    ...(task.recurrence ? { repeat: RECURRENCE_LABELS[task.recurrence] } : {}),
    ...(task.remindAt ? { remind: formatDue({ due: task.remindAt, dueHasTime: true }) } : {}),
    status: task.done ? '已完成' : '未完成',
  }
}

const taskFields = {
  notes: z.string().optional().describe('备注'),
  due: z.string().optional().describe('截止时间：YYYY-MM-DD，有具体时刻时为 YYYY-MM-DD HH:mm'),
  priority: z.enum(['low', 'normal', 'high']).optional().describe('优先级，默认 normal'),
  tags: z.array(z.string()).optional().describe('标签，如 ["工作"]'),
  recurrence: z.enum(RECURRENCES).optional().describe('重复：daily 每天、weekdays 每个工作日、weekly 每周、monthly 每月，完成后自动生成下一次'),
  remindAt: z.string().optional().describe('提醒时间，YYYY-MM-DD HH:mm，到时桌宠会主动提醒'),
  remindInMinutes: z.number().positive().optional().describe('多少分钟后提醒，用于「十分钟后」这类相对时间；与 remindAt 只填一个'),
}

export const tasksSkill: Skill = {
  id: TASKS_SKILL_ID,
  name: '待办',
  description: '管理用户的待办任务与提醒：记下要做的事（可以有截止时间、优先级、标签、重复），设置定时提醒或倒计时（到时桌宠会主动提醒），查询待办与提醒（今天要做什么、有哪些逾期、设了哪些提醒），修改、完成、取消或删除任务。',
  examples: ['帮我记一下明天下午三点交周报', '十分钟后提醒我喝水', '我今天还有什么要做的', '把交周报改到周五', '周报写完了', '每周一提醒我开例会'],
  instructions: `- 用户提到要做的事、待办、任务、清单、计划要完成的事情，或者要求定时提醒、倒计时时使用。提醒也是一个待办任务，到了提醒时间桌宠会主动提醒用户。
- 创建任务时把相对时间换算成具体时间：due 为截止时间（YYYY-MM-DD，有具体时刻时为 YYYY-MM-DD HH:mm）；没有提到截止时间就不填。
- 用户希望到时被提醒时：「十分钟后」「半小时后」这类相对时间填 remindInMinutes，具体时刻（如「下午三点」）填 remindAt；只说了截止时刻并要求提醒时，remindAt 与 due 相同。时间不明确（如「待会儿」）时不要猜测，说明需要用户给出具体时间。
- 单纯的提醒（如「十分钟后提醒我喝水」）只填 title 与提醒时间，title 写要做的事（如「喝水」），没说具体事情时写「时间到了」。
- 查看「设了哪些提醒」时用 list_tasks 列出未完成的任务，挑出带有提醒时间（remind）的；取消某个提醒用 update_task 把 remindAt 设为 none。
- 重复的任务（如每周一开例会）填写 recurrence，并把 due 设为下一次的时间。
- 修改、完成、删除任务需要任务 id：先用 list_tasks 找到对应的任务。完成任务用 complete_task；删除任务会先请求用户确认。
- 查询时根据用户的说法选择 range：今天的用 today（同时可以查一下 overdue 提醒逾期的任务），明天的用 tomorrow，这周的用 week，接下来几天的用 upcoming。
- 汇报时说清楚任务内容与截止时间，任务很多时按截止时间挑重要的说。`,
  tools: {
    create_task: tool({
      description: '创建待办任务',
      inputSchema: z.object({ title: z.string().min(1).describe('任务内容，简洁明确，如「交周报」'), ...taskFields }),
      execute: async ({ title, notes, due, priority, tags, recurrence, remindAt, remindInMinutes }) => {
        const task = useTasksStore().createTask({ title, notes, priority, tags, recurrence, ...dueInput(due), ...remindInput(remindAt, remindInMinutes) })
        return { created: describe(task) }
      },
    }),

    list_tasks: tool({
      description: '查询待办任务（按截止时间排序）',
      inputSchema: z.object({
        status: z.enum(['todo', 'done', 'all']).optional().describe('默认 todo（未完成）'),
        range: z.enum(['all', 'overdue', 'today', 'tomorrow', 'week', 'upcoming', 'nodue']).optional()
          .describe('overdue 逾期；today 今天；tomorrow 明天；week 本周；upcoming 未来 7 天；nodue 没有截止时间；默认 all'),
        tag: z.string().optional().describe('只看带有这个标签的任务'),
        keyword: z.string().optional().describe('任务内容或备注中的关键词'),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      execute: async ({ status, range, tag, keyword, limit }) => {
        const tasks = filterTasks(useTasksStore().tasks, { status, range, tag, keyword })
        return { count: tasks.length, tasks: tasks.slice(0, limit ?? 20).map(describe) }
      },
    }),

    update_task: tool({
      description: '修改任务；due、recurrence、remindAt 填 none 表示清除',
      inputSchema: z.object({
        id: z.string().describe('任务 id，通过 list_tasks 获取'),
        title: z.string().optional(),
        ...taskFields,
        recurrence: z.enum([...RECURRENCES, 'none']).optional().describe('重复规则，none 表示不再重复'),
      }),
      execute: async ({ id, title, notes, due, priority, tags, recurrence, remindAt, remindInMinutes }) => {
        const task = useTasksStore().updateTask(id, {
          title,
          notes,
          priority,
          tags,
          ...(recurrence ? { recurrence: recurrence === 'none' ? null : recurrence as TaskRecurrence } : {}),
          ...dueInput(due),
          ...remindInput(remindAt, remindInMinutes),
        })
        return { updated: describe(task) }
      },
    }),

    complete_task: tool({
      description: '把任务标记为已完成（重复的任务会生成下一次）',
      inputSchema: z.object({ ids: z.array(z.string()).min(1).describe('任务 id') }),
      execute: async ({ ids }) => {
        const store = useTasksStore()
        const results = ids.map((id) => store.completeTask(id))
        return {
          completed: results.map(({ task }) => task.title),
          next: results.flatMap(({ next }) => (next ? [describe(next)] : [])),
        }
      },
    }),

    delete_tasks: tool({
      description: '删除任务（需要用户确认）',
      inputSchema: z.object({
        ids: z.array(z.string()).min(1).describe('任务 id'),
        reason: z.string().min(1).describe('向用户说明为什么删除，一句话'),
      }),
      execute: async ({ ids, reason }, options) => {
        const store = useTasksStore()
        const tasks = store.tasks.filter((task) => ids.includes(task.id))
        if (tasks.length === 0) throw new Error('没有找到这些任务')

        const allowed = await getSkillContext(options).requestPermission?.({
          kind: TASKS_DELETE_PERMISSION,
          title: `删除 ${tasks.length} 个待办`,
          reason,
          target: tasks.map((task) => `· ${task.title}${task.due !== undefined ? `（${formatDue(task)}）` : ''}`).join('\n'),
          targetLabel: '任务',
        }) ?? false
        if (!allowed) return { deleted: 0, message: '用户拒绝了删除' }

        return { deleted: store.deleteTasks(tasks.map((task) => task.id)).map((task) => task.title) }
      },
    }),
  },
}
