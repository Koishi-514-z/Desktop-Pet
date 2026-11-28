<script setup lang="ts">
import type { PlanStatus } from '@/agent/plan'
import type { AgentTrace, TraceNode, TraceStatus, TraceStep, TraceTool } from '@/agent/trace'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ASK_USER_TOOL } from '@/agent/ask'
import { COMPLEX_MAX_STEPS, LOAD_SKILLS_TOOL } from '@/agent/executor'
import { PLAN_TOOL, planProgress } from '@/agent/plan'
import { builtinSkills } from '@/agent/skills'
import { isTraceRunning, traceStats } from '@/agent/trace'

const props = defineProps<{
  trace: AgentTrace
  // 是否是正在生成的这条回复
  live: boolean
}>()

// ===== 时间 =====

// 进行中时每隔一小段时间刷新，让耗时跟着走
const clock = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined

const running = computed(() => props.live && isTraceRunning(props.trace))

watch(running, (value) => {
  clearInterval(timer)
  timer = undefined
  if (value) {
    clock.value = Date.now()
    timer = setInterval(() => (clock.value = Date.now()), 200)
  }
}, { immediate: true })

onBeforeUnmount(() => clearInterval(timer))

// 应用在执行中途被关闭时，执行过程没有结束时间，以最后一次活动的时间为准
const interrupted = computed(() => !props.live && isTraceRunning(props.trace))

function lastActivity(trace: AgentTrace): number {
  const times = trace.nodes.flatMap((node) => [
    node.startedAt,
    node.endedAt ?? 0,
    ...(node.kind === 'step' ? node.tools.flatMap((tool) => [tool.startedAt, tool.endedAt ?? 0]) : []),
  ])
  return Math.max(trace.startedAt, ...times)
}

const now = computed(() => (running.value ? clock.value : props.trace.endedAt ?? lastActivity(props.trace)))

function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`
  return `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`
}

function elapsed(item: { startedAt: number, endedAt?: number }): string {
  return formatDuration((item.endedAt ?? now.value) - item.startedAt)
}

// ===== 展开与收起 =====

// 进行中时默认展开；结束后自动收起，用户手动操作过就不再自动改变
const expanded = ref(running.value)
let toggledByUser = false

watch(running, (value) => {
  if (!toggledByUser) expanded.value = value
})

function toggle() {
  toggledByUser = true
  expanded.value = !expanded.value
}

const openTools = ref(new Set<string>())

function toggleTool(tool: TraceTool) {
  const set = new Set(openTools.value)
  if (set.has(tool.id)) set.delete(tool.id)
  else set.add(tool.id)
  openTools.value = set
}

// ===== 文字 =====

// 工具名对应的技能名称
const toolSkillNames = new Map(builtinSkills.flatMap((skill) => Object.keys(skill.tools).map((name) => [name, skill.name] as const)))

// 执行过程中内置的工具（不属于任何技能）
const BUILTIN_TOOL_LABELS: Record<string, string> = {
  [LOAD_SKILLS_TOOL]: '加载技能',
  [PLAN_TOOL]: '更新计划',
  [ASK_USER_TOOL]: '询问用户',
}

function toolLabel(name: string): string {
  return BUILTIN_TOOL_LABELS[name] ?? name
}

function toolSkill(name: string): string {
  return name in BUILTIN_TOOL_LABELS ? '' : toolSkillNames.get(name) ?? ''
}

// ===== 执行计划 =====

const PLAN_STATUS_TITLES: Record<PlanStatus, string> = {
  done: '已完成',
  in_progress: '正在进行',
  pending: '还没开始',
  skipped: '不再需要',
}

const planText = computed(() => {
  if (!props.trace.plan?.length) return ''
  const { done, total } = planProgress(props.trace.plan)
  return `计划 ${done}/${total}`
})

const FINISH_REASONS: Record<string, string> = {
  'tool-calls': '调用工具',
  'stop': '完成',
  'length': '输出超出长度上限',
  'content-filter': '被内容审核拦截',
  'error': '出错',
}

// 各轮的编号（直接调用的工具与轮数用完后的总结不算一轮）
const stepNumbers = computed(() => {
  const numbers = new Map<TraceNode, number>()
  let count = 0
  for (const node of props.trace.nodes) {
    if (node.kind === 'step' && !node.direct && !node.summary) numbers.set(node, ++count)
  }
  return numbers
})

function nodeTitle(node: TraceNode): string {
  switch (node.kind) {
    case 'route':
      return node.stage === 'image' ? '识别图片中的要求' : '意图识别'
    case 'step':
      if (node.direct) return '直接调用'
      if (node.summary) return '总结'
      return `第 ${stepNumbers.value.get(node)} 轮`
    case 'reply':
      return '生成回复'
  }
}

function routeResult(node: Extract<TraceNode, { kind: 'route' }>): string {
  if (node.status === 'running') return '识别中…'
  // 旧版本的记录：意图识别时直接选择技能
  if (node.task === undefined) return node.skills?.length ? `选择了 ${node.skills.join('、')}` : '没有结果'
  if (!node.task) return node.stage === 'image' ? '只是想看懂图片' : '闲聊，不需要技能'
  const parts = [node.stage === 'image' ? '图片中是要完成的任务' : '需要使用技能']
  if (node.complex) parts.push(`复杂任务，最多 ${COMPLEX_MAX_STEPS} 轮`)
  if (node.preloaded?.length) parts.push(`预先加载了 ${node.preloaded.join('、')}`)
  return parts.join(' · ')
}

function stepMeta(step: TraceStep): string {
  const parts: string[] = []
  if (step.summary) parts.push('轮数用完了，根据已有信息总结')
  else if (step.finishReason) parts.push(FINISH_REASONS[step.finishReason] ?? step.finishReason)
  else if (step.status === 'running' && !step.direct) parts.push(step.tools.length ? '调用工具中' : '思考中')
  if (step.outputTokens !== undefined) parts.push(`${step.outputTokens} tokens`)
  return parts.join(' · ')
}

function toolStateText(tool: TraceTool): string {
  if (tool.status !== 'running') return elapsed(tool)
  if (tool.input === undefined) return tool.chars ? `编写参数中（${tool.chars} 字）` : '编写参数中'
  return `${tool.name === ASK_USER_TOOL ? '等待回答' : '执行中'} ${elapsed(tool)}`
}

const stats = computed(() => traceStats(props.trace, now.value))

// 进行中时标题栏显示当前正在做什么
const activity = computed(() => {
  const node = [...props.trace.nodes].reverse().find((item) => item.status === 'running')
  if (!node) return '准备中…'
  if (node.kind !== 'step') return `${nodeTitle(node)}中…`
  const tool = [...node.tools].reverse().find((item) => item.status === 'running')
  if (!tool) return `${nodeTitle(node)} · 思考中…`
  if (tool.name === ASK_USER_TOOL && tool.input !== undefined) return `${nodeTitle(node)} · 正在等待你的回答`
  const label = toolLabel(tool.name)
  return `${nodeTitle(node)} · ${tool.input === undefined ? `正在编写 ${label} 的参数` : `正在调用 ${label}`}`
})

const summary = computed(() => {
  const { rounds, toolCalls, failed } = stats.value
  return [
    rounds ? `${rounds} 轮` : '',
    `${toolCalls} 次工具调用`,
    failed ? `${failed} 次失败` : '',
    formatDuration(stats.value.durationMs),
  ].filter(Boolean).join(' · ')
})

const overallStatus = computed<TraceStatus>(() => {
  if (running.value) return 'running'
  return props.trace.error || stats.value.failed ? 'error' : 'done'
})
</script>

<template>
  <div class="agent-trace" :class="[overallStatus, { expanded }]">
    <button class="trace-head" type="button" :title="expanded ? '收起执行过程' : '展开执行过程'" @click="toggle">
      <span class="status-icon" :class="overallStatus" />
      <span class="trace-title">{{ running ? '执行中' : '执行过程' }}</span>
      <span class="trace-summary"><template v-if="planText">{{ planText }} · </template>{{ running ? activity : summary }}<template v-if="interrupted"> · 已中断</template></span>
      <span v-if="running" class="trace-time">{{ formatDuration(stats.durationMs) }}</span>
      <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>

    <section v-if="expanded && trace.plan?.length" class="trace-plan">
      <header class="plan-head">
        <span class="plan-title">计划</span>
        <span class="plan-progress">{{ planText }}</span>
      </header>
      <ol class="plan-steps">
        <li
          v-for="(step, stepIndex) in trace.plan"
          :key="stepIndex"
          class="plan-step"
          :class="[step.status, { live: running }]"
          :title="PLAN_STATUS_TITLES[step.status]"
        >
          <span class="plan-mark">
            <svg v-if="step.status === 'done'" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
          </span>
          <span class="plan-text">{{ step.title }}</span>
        </li>
      </ol>
    </section>

    <ol v-if="expanded" class="trace-nodes">
      <li v-for="(node, nodeIndex) in trace.nodes" :key="nodeIndex" class="trace-node" :class="[node.kind, node.status]">
        <span class="status-icon" :class="node.status" />
        <div class="node-body">
          <div class="node-head">
            <span class="node-title">{{ nodeTitle(node) }}</span>
            <span v-if="node.kind === 'step'" class="node-meta">{{ stepMeta(node) }}</span>
            <span v-else-if="node.kind === 'route'" class="node-meta">{{ routeResult(node) }}</span>
            <span class="node-time">{{ elapsed(node) }}</span>
          </div>
          <p v-if="node.kind === 'route' && node.reason" class="node-note">{{ node.reason }}</p>
          <p v-if="node.kind === 'route' && node.steps?.length" class="node-note">
            拆成 {{ node.steps.length }} 步：{{ node.steps.map((step, i) => `${i + 1}. ${step}`).join('　') }}
          </p>

          <ul v-if="node.kind === 'step' && node.tools.length" class="trace-tools">
            <li v-for="tool in node.tools" :key="tool.id" class="trace-tool" :class="tool.status">
              <button class="tool-row" type="button" :disabled="tool.input === undefined" @click="toggleTool(tool)">
                <span class="status-icon small" :class="tool.status" />
                <span class="tool-name">{{ toolLabel(tool.name) }}</span>
                <span v-if="toolSkill(tool.name)" class="tool-skill">{{ toolSkill(tool.name) }}</span>
                <span class="tool-summary">{{ tool.summary }}</span>
                <span class="tool-time">{{ toolStateText(tool) }}</span>
              </button>
              <p v-if="tool.error && !openTools.has(tool.id)" class="tool-error">{{ tool.error }}</p>
              <div v-if="openTools.has(tool.id)" class="tool-detail">
                <span class="detail-label">参数</span>
                <pre>{{ tool.input }}</pre>
                <template v-if="tool.error">
                  <span class="detail-label error">错误</span>
                  <pre class="error">{{ tool.error }}</pre>
                </template>
                <template v-else-if="tool.output !== undefined">
                  <span class="detail-label">结果</span>
                  <pre>{{ tool.output }}</pre>
                </template>
              </div>
            </li>
          </ul>
        </div>
      </li>
      <li v-if="trace.error" class="trace-error">{{ trace.error }}</li>
    </ol>
  </div>
</template>

<style scoped src="../css/AgentTrace.css"></style>
