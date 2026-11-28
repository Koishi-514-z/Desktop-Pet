import type { PlanStep } from '@/agent/plan'
import type { AgentEvent } from '@/agent/types'
import { ASK_USER_TOOL, describeAnswer, describeQuestion } from '@/agent/ask'
import { describeProgress, PLAN_TOOL, planFromInput } from '@/agent/plan'
import { stringify, summarizeInput, truncate } from '@/agent/utils'

/**
 * Agent 的执行过程（意图识别 → 若干轮工具执行 → 生成回复），由 AgentEvent 逐步累积而成，
 * 保存在 assistant 消息上，用于在界面上展示每一步做了什么、用了多久。
 *
 * 会随会话一起保存到本地，所以参数与结果只保留截断后的文本。
 */

export type TraceStatus = 'running' | 'done' | 'error'

/** 一次工具调用 */
export interface TraceTool {
  id: string
  name: string
  status: TraceStatus
  /** 开始执行的时间；还在编写参数时为开始编写的时间 */
  startedAt: number
  endedAt?: number
  /** 模型正在编写参数时已写的字数 */
  chars?: number
  /** 一行的参数摘要 */
  summary?: string
  /** 参数（格式化后截断），为空表示参数还没有写完 */
  input?: string
  output?: string
  error?: string
}

/** 意图识别：intent 为开始时区分闲聊与任务，image 为读出图片后判断图中是不是要完成的任务 */
export interface TraceRoute {
  kind: 'route'
  stage: 'intent' | 'image'
  status: TraceStatus
  startedAt: number
  endedAt?: number
  /** 是否判断为任务 */
  task?: boolean
  reason?: string
  /** 是否是需要较多步骤的任务（允许更多轮的工具调用） */
  complex?: boolean
  /** 开始执行时预先加载的技能名称（意图识别选出的，或者如用户发了图片时的图片理解） */
  preloaded?: string[]
  /** 意图识别把请求拆成的步骤（多于一步时） */
  steps?: string[]
  /** 旧版本的记录：意图识别选中的技能名称 */
  skills?: string[]
}

/**
 * 工具执行的一轮 LLM 调用。direct 表示不经过 LLM、直接调用的工具（如划词工具栏上的按钮）；
 * summary 表示轮数用完后，不带工具、根据执行记录做的总结
 */
export interface TraceStep {
  kind: 'step'
  status: TraceStatus
  startedAt: number
  endedAt?: number
  direct?: boolean
  summary?: boolean
  finishReason?: string
  outputTokens?: number
  tools: TraceTool[]
}

/** 以角色口吻生成最终回复 */
export interface TraceReply {
  kind: 'reply'
  status: TraceStatus
  startedAt: number
  endedAt?: number
}

export type TraceNode = TraceRoute | TraceStep | TraceReply

export interface AgentTrace {
  startedAt: number
  endedAt?: number
  nodes: TraceNode[]
  /** 执行计划的最新状态（LLM 用 update_plan 制定过计划时） */
  plan?: PlanStep[]
  /** 执行过程出错时的错误信息 */
  error?: string
}

// 保存的参数与结果的长度上限（会话保存在 IndexedDB 中，空间充足）
const DETAIL_LENGTH = 2000
// 保存的计划中每一步的长度上限
const PLAN_TITLE_LENGTH = 200

export function createTrace(now = Date.now()): AgentTrace {
  return { startedAt: now, nodes: [] }
}

/** 格式化为便于阅读的多行文本并截断 */
export function formatDetail(value: unknown, maxLength = DETAIL_LENGTH): string {
  if (typeof value === 'string') return truncate(value, maxLength)
  try {
    return truncate(JSON.stringify(value, null, 2) ?? '（无）', maxLength)
  }
  catch {
    return stringify(value, maxLength)
  }
}

function lastRunning<T extends TraceNode['kind']>(trace: AgentTrace, kind: T): Extract<TraceNode, { kind: T }> | undefined {
  for (let i = trace.nodes.length - 1; i >= 0; i--) {
    const node = trace.nodes[i]!
    if (node.kind === kind && node.status === 'running') return node as Extract<TraceNode, { kind: T }>
  }
  return undefined
}

/**
 * 在当前这一轮中按 id 查找工具调用。工具的结果总是在同一轮中返回；
 * 部分服务商的 id 只在一次响应内唯一（如每轮都从 call_0 开始），所以不在之前的轮次中查找
 */
function findTool(trace: AgentTrace, id: string): TraceTool | undefined {
  return lastRunning(trace, 'step')?.tools.find((item) => item.id === id)
}

/** 结束仍在进行中的意图识别（如识别失败时不会收到 routed 事件） */
function closeRoutes(trace: AgentTrace, now: number) {
  for (const node of trace.nodes) {
    if (node.kind === 'route' && node.status === 'running') {
      node.status = 'done'
      node.endedAt = now
    }
  }
}

/** 当前的一轮；直接调用工具时没有 LLM 的轮次，新建一个 direct 的分组 */
function currentStep(trace: AgentTrace, now: number): TraceStep {
  const running = lastRunning(trace, 'step')
  if (running) return running
  closeRoutes(trace, now)
  const step: TraceStep = { kind: 'step', status: 'running', startedAt: now, direct: true, tools: [] }
  trace.nodes.push(step)
  return step
}

/** 根据 Agent 事件更新执行过程 */
export function applyAgentEvent(trace: AgentTrace, event: AgentEvent, now = Date.now()) {
  switch (event.type) {
    case 'routing':
      trace.nodes.push({ kind: 'route', stage: event.stage ?? 'intent', status: 'running', startedAt: now })
      break

    case 'routed': {
      const route = lastRunning(trace, 'route')
      if (!route) break
      route.status = 'done'
      route.endedAt = now
      route.task = event.decision.task
      route.reason = event.decision.reason
      if (event.decision.complex) route.complex = true
      if (event.decision.task && event.decision.steps && event.decision.steps.length > 1) route.steps = event.decision.steps
      break
    }

    case 'skills-loaded': {
      // 开始执行前预先加载的技能记在意图识别上；执行中用 load_skills 加载的，已经作为工具调用展示了
      const last = trace.nodes.at(-1)
      if (last?.kind === 'route') last.preloaded = event.skills.map((skill) => skill.name)
      break
    }

    case 'step-start':
      closeRoutes(trace, now)
      trace.nodes.push({ kind: 'step', status: 'running', startedAt: now, tools: [], ...(event.summary ? { summary: true } : {}) })
      break

    case 'step-finish': {
      const step = lastRunning(trace, 'step')
      if (!step) break
      step.status = event.finishReason === 'error' ? 'error' : 'done'
      step.endedAt = now
      step.finishReason = event.finishReason
      step.outputTokens = event.outputTokens
      break
    }

    case 'tool-input': {
      const existing = findTool(trace, event.toolCallId)
      if (existing) {
        existing.chars = event.chars
        break
      }
      currentStep(trace, now).tools.push({ id: event.toolCallId, name: event.toolName, status: 'running', startedAt: now, chars: event.chars })
      break
    }

    case 'tool-call': {
      const tool = findTool(trace, event.toolCallId)
      // 更新计划时，摘要显示计划的进度；向用户提问时显示问题
      const plan = event.toolName === PLAN_TOOL ? planFromInput(event.input) : undefined
      const question = event.toolName === ASK_USER_TOOL ? describeQuestion(event.input) : undefined
      const fields = {
        name: event.toolName,
        startedAt: now,
        summary: plan ? describeProgress(plan) : question ?? summarizeInput(event.input),
        input: formatDetail(event.input),
      }
      if (tool) Object.assign(tool, fields)
      else currentStep(trace, now).tools.push({ id: event.toolCallId, status: 'running', ...fields })
      break
    }

    case 'tool-result': {
      const { record } = event
      let tool = findTool(trace, event.toolCallId)
      if (!tool) {
        // 参数校验失败等情况可能没有 tool-call 事件
        tool = { id: event.toolCallId, name: record.toolName, status: 'running', startedAt: now, summary: summarizeInput(record.input), input: formatDetail(record.input) }
        currentStep(trace, now).tools.push(tool)
      }
      tool.endedAt = now
      if (record.error !== undefined) {
        tool.status = 'error'
        tool.error = truncate(record.error, DETAIL_LENGTH)
      }
      else {
        tool.status = 'done'
        tool.output = formatDetail(record.output)
        // 向用户提问：摘要中补上用户的回答
        if (record.toolName === ASK_USER_TOOL) tool.summary = describeAnswer(record.input, record.output) ?? tool.summary
      }
      // 直接调用的工具完成后，这一组也就结束了
      const step = lastRunning(trace, 'step')
      if (step?.direct && step.tools.every((item) => item.status !== 'running')) {
        step.status = step.tools.some((item) => item.status === 'error') ? 'error' : 'done'
        step.endedAt = now
      }
      break
    }

    case 'plan':
      trace.plan = event.steps.map((step) => ({ title: truncate(step.title, PLAN_TITLE_LENGTH), status: step.status }))
      break
  }
}

/** 结束所有仍在进行中的步骤：出错时标记为失败 */
function closeRunning(trace: AgentTrace, now: number, error?: string) {
  for (const node of trace.nodes) {
    if (node.kind === 'step') {
      for (const tool of node.tools) {
        if (tool.status !== 'running') continue
        tool.status = error ? 'error' : 'done'
        tool.endedAt = now
      }
    }
    if (node.status !== 'running') continue
    node.status = error && node.kind !== 'route' ? 'error' : 'done'
    node.endedAt = now
  }
}

/** 工具执行阶段结束、开始生成回复。executionError 为执行阶段本身的错误（如模型请求失败） */
export function startReply(trace: AgentTrace, now = Date.now(), executionError?: string) {
  closeRunning(trace, now, executionError)
  if (executionError) trace.error = truncate(executionError, DETAIL_LENGTH)
  trace.nodes.push({ kind: 'reply', status: 'running', startedAt: now })
}

/** 整轮回复结束；error 为生成回复时的错误 */
export function finishTrace(trace: AgentTrace, now = Date.now(), error?: string) {
  closeRunning(trace, now, error)
  if (error) trace.error = truncate(error, DETAIL_LENGTH)
  trace.endedAt = now
}

export function isTraceRunning(trace: AgentTrace): boolean {
  return trace.endedAt === undefined
}

export interface TraceStats {
  /** 调用工具的轮数（不含直接调用与轮数用完后的总结） */
  rounds: number
  toolCalls: number
  failed: number
  durationMs: number
}

export function traceStats(trace: AgentTrace, now = Date.now()): TraceStats {
  const steps = trace.nodes.filter((node): node is TraceStep => node.kind === 'step')
  const tools = steps.flatMap((step) => step.tools)
  return {
    rounds: steps.filter((step) => !step.direct && !step.summary).length,
    toolCalls: tools.length,
    failed: tools.filter((tool) => tool.status === 'error').length,
    durationMs: (trace.endedAt ?? now) - trace.startedAt,
  }
}

/** 是否执行过工具：普通闲聊只有意图识别与生成回复，不需要展示执行过程 */
export function hasExecution(trace: AgentTrace): boolean {
  return trace.nodes.some((node) => node.kind === 'step')
}
