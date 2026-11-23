<script setup lang="ts">
import type { Task, TaskPriority, TaskRange, TaskRecurrence } from '@/tasks/model'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useTasksStore } from '@/stores/tasks'
import { filterTasks, formatDue, isOverdue, parseDue, PRIORITY_LABELS, RECURRENCE_LABELS } from '@/tasks/model'

// 面板默认尺寸，窗口较小时由 CSS 自动收缩
const PANEL_WIDTH = 360
const PANEL_HEIGHT = 540

const tasksStore = useTasksStore()

const visible = ref(false)
const position = ref({ x: 0, y: 0 })
const error = ref('')

// ===== 筛选 =====

type View = 'todo' | 'today' | 'overdue' | 'week' | 'done'
const view = ref<View>('todo')

const VIEWS: { id: View, label: string }[] = [
  { id: 'todo', label: '待办' },
  { id: 'today', label: '今天' },
  { id: 'overdue', label: '逾期' },
  { id: 'week', label: '本周' },
  { id: 'done', label: '已完成' },
]

// 每分钟刷新一次，让「逾期」「今天」等状态随时间更新
const now = ref(new Date())
let clock: ReturnType<typeof setInterval> | undefined

const visibleTasks = computed(() => {
  const range: TaskRange = view.value === 'todo' || view.value === 'done' ? 'all' : view.value
  return filterTasks(tasksStore.tasks, { status: view.value === 'done' ? 'done' : 'todo', range }, now.value)
})

function count(target: View) {
  if (target === 'todo') return tasksStore.pending.length
  if (target === 'overdue') return tasksStore.overdueCount
  return 0
}

// ===== 新增 =====

const draft = reactive({ title: '', date: '', time: '', priority: 'normal' as TaskPriority })

function dueFrom(date: string, time: string) {
  if (!date) return { due: null }
  const parsed = parseDue(time ? `${date} ${time}` : date)
  return parsed ? { due: parsed.due, dueHasTime: parsed.hasTime } : { due: null }
}

function add() {
  if (!draft.title.trim()) return
  run(() => {
    tasksStore.createTask({ title: draft.title, priority: draft.priority, ...dueFrom(draft.date, draft.time) })
    Object.assign(draft, { title: '', date: '', time: '', priority: 'normal' })
  })
}

// ===== 编辑 =====

const editingId = ref<string | null>(null)
const listRef = ref<HTMLUListElement | null>(null)
const edit = reactive({
  title: '',
  notes: '',
  date: '',
  time: '',
  priority: 'normal' as TaskPriority,
  tags: '',
  recurrence: '' as TaskRecurrence | '',
  remindDate: '',
  remindTime: '',
})

function pad(value: number) {
  return String(value).padStart(2, '0')
}

function dateInput(time: number | undefined) {
  if (time === undefined) return ''
  const date = new Date(time)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function timeInput(time: number | undefined) {
  if (time === undefined) return ''
  const date = new Date(time)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function startEdit(task: Task) {
  editingId.value = task.id
  Object.assign(edit, {
    title: task.title,
    notes: task.notes ?? '',
    date: dateInput(task.due),
    time: task.dueHasTime ? timeInput(task.due) : '',
    priority: task.priority,
    tags: task.tags.join('，'),
    recurrence: task.recurrence ?? '',
    remindDate: dateInput(task.remindAt),
    remindTime: timeInput(task.remindAt),
  })
  // 编辑表单比任务条目高，展开后滚动到能看到「保存」按钮的位置
  nextTick(() => listRef.value?.querySelector('.edit')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
}

function saveEdit(task: Task) {
  run(() => {
    const remind = edit.remindDate && edit.remindTime ? parseDue(`${edit.remindDate} ${edit.remindTime}`) : undefined
    tasksStore.updateTask(task.id, {
      title: edit.title,
      notes: edit.notes,
      priority: edit.priority,
      tags: edit.tags.split(/[,，\s]+/),
      recurrence: edit.recurrence || null,
      remindAt: remind ? remind.due : null,
      ...dueFrom(edit.date, edit.time),
    })
    editingId.value = null
  })
}

// ===== 操作 =====

function run(action: () => void) {
  try {
    action()
    error.value = ''
  }
  catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

function toggle(task: Task) {
  run(() => (task.done ? tasksStore.reopenTask(task.id) : tasksStore.completeTask(task.id)))
}

function remove(task: Task) {
  run(() => tasksStore.deleteTasks([task.id]))
}

// ===== 拖拽 =====

let dragOffset: { x: number, y: number } | null = null

function startDrag(event: PointerEvent) {
  if ((event.target as HTMLElement).closest('button')) return
  dragOffset = { x: event.clientX - position.value.x, y: event.clientY - position.value.y }
  window.addEventListener('pointermove', onDrag)
  window.addEventListener('pointerup', stopDrag)
}

function onDrag(event: PointerEvent) {
  if (!dragOffset) return
  position.value = { x: event.clientX - dragOffset.x, y: event.clientY - dragOffset.y }
}

function stopDrag() {
  dragOffset = null
  window.removeEventListener('pointermove', onDrag)
  window.removeEventListener('pointerup', stopDrag)
}

onMounted(() => {
  // 默认放在对话面板的左侧
  position.value = {
    x: Math.max(16, window.innerWidth - 88 - 600 - 16 - PANEL_WIDTH),
    y: Math.max(16, window.innerHeight - PANEL_HEIGHT - 24),
  }
  clock = setInterval(() => (now.value = new Date()), 60_000)
})

onBeforeUnmount(() => {
  clearInterval(clock)
  stopDrag()
})
</script>

<template>
  <button
    class="task-toggle"
    :class="{ alert: tasksStore.overdueCount > 0 }"
    :title="visible ? '收起待办' : `待办（${tasksStore.pending.length} 项未完成）`"
    @click="visible = !visible"
  >
    {{ visible ? '×' : '☑' }}
    <span v-if="!visible && tasksStore.pending.length" class="badge">{{ tasksStore.pending.length }}</span>
  </button>

  <Transition name="panel">
    <div v-show="visible" class="task-panel" :style="{ left: `${position.x}px`, top: `${position.y}px` }">
      <header class="panel-header" @pointerdown="startDrag">
        <span class="panel-title">待办</span>
        <span class="panel-subtitle">
          {{ tasksStore.pending.length }} 项未完成<template v-if="tasksStore.overdueCount">，<b class="overdue">{{ tasksStore.overdueCount }} 项逾期</b></template>
        </span>
        <button class="icon-button" title="关闭" @click="visible = false">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </header>

      <form class="quick-add" @submit.prevent="add">
        <input v-model="draft.title" class="field title" placeholder="添加待办，也可以在对话里说「明天下午三点交周报」" />
        <div class="row">
          <input v-model="draft.date" class="field date" type="date" title="截止日期" />
          <input v-model="draft.time" class="field" type="time" title="截止时刻（可选）" :disabled="!draft.date" />
          <select v-model="draft.priority" class="field priority" title="优先级">
            <option v-for="(label, id) in PRIORITY_LABELS" :key="id" :value="id">{{ label }}</option>
          </select>
          <button class="add" type="submit" :disabled="!draft.title.trim()">添加</button>
        </div>
      </form>

      <nav class="views">
        <button v-for="item in VIEWS" :key="item.id" class="view" :class="{ active: view === item.id }" type="button" @click="view = item.id">
          {{ item.label }}<span v-if="count(item.id)" class="count">{{ count(item.id) }}</span>
        </button>
      </nav>

      <p v-if="error" class="error">{{ error }}</p>

      <ul ref="listRef" class="tasks">
        <li v-if="visibleTasks.length === 0" class="empty">{{ view === 'done' ? '还没有完成的任务' : '没有待办，轻松一下吧' }}</li>
        <li v-for="task in visibleTasks" :key="task.id" class="task" :class="[`priority-${task.priority}`, { done: task.done }]">
          <template v-if="editingId === task.id">
            <form class="edit" @submit.prevent="saveEdit(task)">
              <input v-model="edit.title" class="field" placeholder="任务内容" />
              <textarea v-model="edit.notes" class="field" rows="2" placeholder="备注" />
              <div class="row">
                <input v-model="edit.date" class="field" type="date" title="截止日期" />
                <input v-model="edit.time" class="field" type="time" title="截止时刻" :disabled="!edit.date" />
              </div>
              <div class="row">
                <select v-model="edit.priority" class="field" title="优先级">
                  <option v-for="(label, id) in PRIORITY_LABELS" :key="id" :value="id">{{ label }}优先级</option>
                </select>
                <select v-model="edit.recurrence" class="field" title="重复">
                  <option value="">不重复</option>
                  <option v-for="(label, id) in RECURRENCE_LABELS" :key="id" :value="id">{{ label }}</option>
                </select>
              </div>
              <div class="row">
                <span class="label">提醒</span>
                <input v-model="edit.remindDate" class="field" type="date" />
                <input v-model="edit.remindTime" class="field" type="time" />
              </div>
              <input v-model="edit.tags" class="field" placeholder="标签，用逗号分隔" />
              <div class="row end">
                <button class="small" type="button" @click="editingId = null">取消</button>
                <button class="small primary" type="submit" :disabled="!edit.title.trim()">保存</button>
              </div>
            </form>
          </template>

          <template v-else>
            <input class="check" type="checkbox" :checked="task.done" :title="task.done ? '标记为未完成' : '完成'" @change="toggle(task)" />
            <div class="body" @dblclick="startEdit(task)">
              <span class="title">{{ task.title }}</span>
              <span v-if="task.notes" class="notes">{{ task.notes }}</span>
              <span class="meta">
                <span v-if="task.due !== undefined" :class="{ overdue: isOverdue(task, now.getTime()) }">{{ formatDue(task, now) }}{{ isOverdue(task, now.getTime()) ? ' · 已逾期' : '' }}</span>
                <span v-if="task.recurrence">↻ {{ RECURRENCE_LABELS[task.recurrence] }}</span>
                <span v-if="task.remindAt && !task.done">⏰ {{ formatDue({ due: task.remindAt, dueHasTime: true }, now) }}</span>
                <span v-for="tag in task.tags" :key="tag" class="tag">#{{ tag }}</span>
              </span>
            </div>
            <div class="actions">
              <button v-if="!task.done" class="icon-button" title="编辑" @click="startEdit(task)">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
              </button>
              <button class="icon-button danger" title="删除" @click="remove(task)">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
              </button>
            </div>
          </template>
        </li>
      </ul>

      <footer v-if="view === 'done' && visibleTasks.length" class="footer">
        <button class="small" type="button" @click="run(() => tasksStore.clearCompleted())">清除已完成</button>
      </footer>
    </div>
  </Transition>
</template>

<style scoped src="../css/TaskPanel.css"></style>
