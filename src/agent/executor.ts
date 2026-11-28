import type { StepResult, TextStreamPart, ToolSet } from 'ai'
import type { PlanStep } from '@/agent/plan'
import type { AgentEvent, AgentResult, AgentRunOptions, DirectToolCall, RouteDecision, Skill, SkillContext, ToolCallRecord, ToolDisplay } from '@/agent/types'
import { stepCountIs, streamText, tool } from 'ai'
import { z } from 'zod'
import { ASK_USER_TOOL, createAskUserTool } from '@/agent/ask'
import { buildStepTranscript, compactToolMessages } from '@/agent/compact'
import { extractDisplay } from '@/agent/context'
import { createPlanTool, PLAN_TOOL, planProgress } from '@/agent/plan'
import { buildExecutorSystemPrompt, buildStepLimitSummaryPrompt, TRUNCATED_OUTPUT_NOTE } from '@/agent/prompts'
import { errorMessage, recentMessages } from '@/agent/utils'

// 工具执行阶段参考的最近消息条数
const EXECUTOR_CONTEXT_SIZE = 10
// 单次执行最多进行的 LLM 调用轮数（每轮可调用若干工具），防止死循环。
// 需要留出余量：如识别图片 → 加载技能 → 读取文件 → 修改文件 → 出错后修正再运行
export const DEFAULT_MAX_STEPS = 10
// 需要查阅较多内容或较多步骤的任务（如了解一个项目）允许的轮数
export const COMPLEX_MAX_STEPS = 20
// 输出超过模型的长度上限、工具调用没有写完时，提醒精简后重试的次数
const MAX_TRUNCATION_RETRIES = 1
// 工具参数（如代码）写到这么多字时开始显示编写进度
const PROGRESS_MIN_CHARS = 200
// 加载其他技能的工具名
export const LOAD_SKILLS_TOOL = 'load_skills'

/** 按意图识别的结果决定这次最多可以进行几轮工具调用 */
export function stepBudget(decision: Pick<RouteDecision, 'complex'>): number {
  return decision.complex ? COMPLEX_MAX_STEPS : DEFAULT_MAX_STEPS
}

/**
 * 跟随流式输出更新界面上的进度：模型思考、编写较长的工具参数（如一段代码）可能要几分钟，
 * 显示进度以免看起来像卡住了。同时取出流中的错误（流出错时 steps 只会报「没有输出」）。
 *
 * 执行过程的事件（每一轮、每次工具调用）也从流中按顺序发出：工具的回调与流中的事件不在同一处触发，
 * 混用时可能出现下一轮的工具调用先于上一轮的结束事件到达的情况
 */
async function followProgress(stream: AsyncIterable<TextStreamPart<ToolSet>>, options: {
  skillsLabel: () => string
  setStatus?: (status: string) => void
  onEvent?: (event: AgentEvent) => void
  stepOffset: number
  // 是否是轮数用完后的总结
  summary?: boolean
}) {
  const { skillsLabel, setStatus, onEvent, summary } = options
  const inputLengths = new Map<string, number>()
  let step = options.stepOffset
  let startedAt = Date.now()
  let error: unknown
  for await (const part of stream) {
    switch (part.type) {
      case 'start-step':
        startedAt = Date.now()
        // 上一步的工具设置的进度（如「正在运行脚本」）已经结束
        if (step > 0) setStatus?.(skillsLabel())
        onEvent?.(summary ? { type: 'step-start', summary } : { type: 'step-start' })
        break
      case 'reasoning-delta':
        setStatus?.(`${skillsLabel()}（思考中…）`)
        break
      case 'tool-input-start':
        inputLengths.set(part.id, 0)
        onEvent?.({ type: 'tool-input', toolCallId: part.id, toolName: part.toolName, chars: 0 })
        break
      case 'tool-input-delta': {
        const previous = inputLengths.get(part.id) ?? 0
        const length = previous + part.delta.length
        inputLengths.set(part.id, length)
        if (length >= PROGRESS_MIN_CHARS) setStatus?.(`${skillsLabel()}（正在编写，已写 ${length} 字）`)
        // 参数较长时（如一段代码）在执行过程中显示编写进度，每写一段更新一次
        if (Math.floor(length / PROGRESS_MIN_CHARS) > Math.floor(previous / PROGRESS_MIN_CHARS)) {
          onEvent?.({ type: 'tool-input', toolCallId: part.id, toolName: '', chars: length })
        }
        break
      }
      case 'tool-call':
        onEvent?.({ type: 'tool-call', toolCallId: part.toolCallId, toolName: part.toolName, input: part.input })
        break
      case 'tool-result':
        onEvent?.({ type: 'tool-result', toolCallId: part.toolCallId, record: { toolName: part.toolName, input: part.input, output: part.output } })
        break
      case 'tool-error':
        onEvent?.({ type: 'tool-result', toolCallId: part.toolCallId, record: { toolName: part.toolName, input: part.input, error: errorMessage(part.error) } })
        break
      case 'finish-step':
        console.debug(`[agent] 第 ${step + 1} 步：${part.finishReason}，输出 ${part.usage.outputTokens ?? '?'} tokens，用时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`)
        onEvent?.({ type: 'step-finish', finishReason: part.finishReason, outputTokens: part.usage.outputTokens })
        step++
        break
      case 'error':
        error ??= part.error
        break
    }
  }
  if (error !== undefined) throw error
}

function createSkillContext(options: AgentRunOptions): SkillContext {
  const { model, visionModel, abortSignal, requestPermission, askUser, attachImages, attachAudios, setStatus } = options
  return { model, visionModel: visionModel ?? model, abortSignal, requestPermission, askUser, attachImages, attachAudios, setStatus }
}

/** 合并多个技能的工具：多个技能共用同一个工具（如 read_file）时只保留一份；不同的工具重名时后者会被忽略 */
export function collectTools(skills: Skill[]): ToolSet {
  const tools: ToolSet = {}
  for (const skill of skills) {
    for (const [name, tool] of Object.entries(skill.tools)) {
      if (name in tools) {
        if (tools[name] !== tool) console.warn(`[agent] 技能 ${skill.id} 的工具 ${name} 与其他技能重名，已忽略`)
        continue
      }
      tools[name] = tool
    }
  }
  return tools
}

/**
 * 「加载技能」工具：意图识别只区分闲聊与任务，需要哪些技能由 LLM 根据技能目录调用这个工具加载；
 * 执行过程中也可能发现还需要其他技能——例如用户截图发来一段要求，读出图片内容后才知道要写 Word 文档。
 * 加载后，之后的步骤中就可以使用它们的工具（使用说明加入系统提示）
 */
function createLoadSkillsTool(available: Skill[], loaded: Map<string, Skill>, onLoaded: (skills: Skill[]) => void) {
  return tool({
    description: '加载「可以加载的技能」中的技能，加载后才能使用它们的工具（使用说明会加入系统提示）。需要多个技能时一次加载',
    inputSchema: z.object({
      skillIds: z.array(z.string()).min(1).describe('要加载的技能 id'),
      reason: z.string().describe('为什么需要这些技能，一句话'),
    }),
    execute: async ({ skillIds }) => {
      const unknown = skillIds.filter((id) => !available.some((skill) => skill.id === id))
      const added = available.filter((skill) => skillIds.includes(skill.id) && !loaded.has(skill.id))
      if (added.length === 0 && unknown.length) {
        throw new Error(`没有这些技能：${unknown.join('、')}。可以加载的技能：${available.filter((skill) => !loaded.has(skill.id)).map((skill) => skill.id).join('、')}`)
      }
      for (const skill of added) loaded.set(skill.id, skill)
      if (added.length) onLoaded(added)
      return {
        loaded: added.map((skill) => skill.name),
        note: '这些技能的使用说明已经加入系统提示，现在可以使用它们的工具了',
      }
    },
  })
}

/**
 * 阶段二：工具执行。按技能的说明自主调用工具（可多轮），并总结执行结果。
 * options.skills 为所有可用的技能，preloaded 为开始时就加载的技能（意图识别选出的、消息中的附件需要的），
 * 还需要其他技能时由 LLM 用 load_skills 加载。plannedSteps 为意图识别拆出的步骤，写进系统提示供参考。
 * maxSteps 为最多进行的轮数，用完时任务还没完成，就不带工具再调用一次模型，根据执行记录总结
 */
export async function executeSkills(
  options: AgentRunOptions,
  preloaded: Skill[] = [],
  maxSteps = DEFAULT_MAX_STEPS,
  complex = false,
  plannedSteps: string[] = [],
): Promise<AgentResult> {
  const { model, messages, skills: available, onEvent, abortSignal } = options
  const loaded = new Map(preloaded.map((skill) => [skill.id, skill]))
  const toolCalls: ToolCallRecord[] = []
  const displays: ToolDisplay[] = []
  const recordedIds = new Set<string>()
  const context = createSkillContext(options)
  const loadedSkills = () => [...loaded.values()]
  const otherSkills = () => available.filter((skill) => !loaded.has(skill.id))

  if (loaded.size) onEvent?.({ type: 'skills-loaded', skills: loadedSkills() })
  const loadSkills = createLoadSkillsTool(available, loaded, () => {
    onEvent?.({ type: 'skills-loaded', skills: loadedSkills() })
  })
  // 执行计划：LLM 用 update_plan 制定与更新，界面上显示为执行过程中的清单
  let plan: PlanStep[] | undefined
  const updatePlan = createPlanTool((steps) => {
    plan = steps
    onEvent?.({ type: 'plan', steps })
  })
  // 结果附上计划的最终状态
  const withPlan = (result: AgentResult): AgentResult => (plan ? { ...result, plan } : result)

  // 所有可用技能的工具都交给 streamText，每一步只启用已加载技能的工具；加载技能与制定计划的工具一直可用，
  // 界面支持提问时还可以向用户提问
  const canAskUser = options.askUser !== undefined
  const tools: ToolSet = { ...collectTools(available), [LOAD_SKILLS_TOOL]: loadSkills, [PLAN_TOOL]: updatePlan, [ASK_USER_TOOL]: createAskUserTool() }
  const activeTools = () => [
    ...Object.keys(collectTools(loadedSkills())),
    ...(otherSkills().length ? [LOAD_SKILLS_TOOL] : []),
    PLAN_TOOL,
    ...(canAskUser ? [ASK_USER_TOOL] : []),
  ]
  const skillsLabel = () => {
    const label = loaded.size ? `正在使用技能：${loadedSkills().map((skill) => skill.name).join('、')}` : '正在分析需要哪些技能'
    if (!plan) return label
    const { done, total } = planProgress(plan)
    return `${label} · 计划 ${done}/${total}`
  }

  try {
    // 背景信息准备失败不影响执行
    const background = await Promise.resolve(options.background).catch(() => '')
    const now = new Date()
    // truncated：之前的输出因为超过长度上限被截断过，提醒模型精简
    const system = (truncated: boolean) => [
      buildExecutorSystemPrompt(loadedSkills(), { now, steps: plannedSteps, background, others: otherSkills(), maxSteps, complex, canAskUser }),
      truncated ? TRUNCATED_OUTPUT_NOTE : '',
    ].filter(Boolean).join('\n\n')

    // 对话上下文（只有文字），轮数用完后总结时也使用它
    const dialog = recentMessages(messages, EXECUTOR_CONTEXT_SIZE)
    let history = dialog
    const steps: StepResult<ToolSet>[] = []
    let truncated = false
    for (let retries = 0; ; retries++) {
      const result = streamText({
        model,
        system: system(truncated),
        messages: history,
        tools,
        activeTools: activeTools(),
        // 每一步开始前按已加载的技能更新系统提示与可用的工具；上一步被截断时提醒精简。
        // 上下文超过预算时，精简较早的工具结果（只影响这一步交给模型的消息）
        prepareStep: ({ steps: previous, messages: stepMessages }) => {
          if (previous.at(-1)?.finishReason === 'length') truncated = true
          return { system: system(truncated), activeTools: activeTools(), messages: compactToolMessages(stepMessages) }
        },
        stopWhen: stepCountIs(maxSteps - steps.length),
        temperature: 0,
        abortSignal,
        experimental_context: context,
        // 这里只记录工具调用的结果；界面上的执行过程由 followProgress 从流中按顺序发出
        experimental_onToolCallFinish: (event) => {
          // 加载技能、制定计划只是执行过程中的步骤，不作为工具调用的结果交给角色扮演阶段（计划单独附在结果上）
          const { toolName, toolCallId } = event.toolCall
          if (toolName === PLAN_TOOL || (toolName === LOAD_SKILLS_TOOL && event.success)) {
            recordedIds.add(toolCallId)
            return
          }
          const record: ToolCallRecord = { toolName: event.toolCall.toolName, input: event.toolCall.input }
          if (event.success) {
            record.output = event.output
            const display = extractDisplay(event.output)
            if (display) displays.push(display)
          }
          else {
            record.error = errorMessage(event.error) 
          }
          recordedIds.add(event.toolCall.toolCallId)
          toolCalls.push(record)
        },
      })

      await followProgress(result.fullStream, {
        skillsLabel,
        setStatus: options.setStatus,
        onEvent,
        stepOffset: steps.length,
      })
      const attempt = await result.steps
      steps.push(...attempt)

      // 输出超过长度上限时，OpenAI 兼容的接口会丢弃没写完的工具调用，执行就此结束。
      // 这时带着之前的步骤与精简的提醒重新生成一次（只重试一次，避免长时间卡住）
      const last = attempt.at(-1)
      if (last?.finishReason !== 'length' || retries >= MAX_TRUNCATION_RETRIES || steps.length >= maxSteps) break
      console.warn('[agent] 输出超过了模型的长度上限，没有写完，提醒精简后重试')
      truncated = true
      history = [...history, ...(attempt.at(-2)?.response.messages ?? [])]
    }

    // 参数校验失败、调用了不存在的工具等情况不会执行工具，也就不会触发上面的回调，这里从步骤记录中补上
    // （制定计划的参数有误时，模型会看到错误并改正，不交给角色扮演阶段）
    for (const part of steps.flatMap((step) => step.content)) {
      if (part.type !== 'tool-error' || part.toolName === PLAN_TOOL || recordedIds.has(part.toolCallId)) continue
      toolCalls.push({ toolName: part.toolName, input: part.input, error: errorMessage(part.error) })
    }

    const last = steps.at(-1)
    if (last?.finishReason === 'length' && last.toolCalls.length === 0) {
      return withPlan({
        skills: loadedSkills(),
        toolCalls,
        displays,
        summary: last.text,
        error: '模型的输出超过了单次输出的长度上限，内容没有写完，精简后重试仍然不够。可以把任务拆成几部分分别完成（如先做前几页），或者换用输出上限更高的模型',
      })
    }

    // 轮数用完时模型还在调用工具，最后一步没有总结：不带工具再调用一次，根据执行记录总结
    if (last?.finishReason === 'tool-calls' && steps.length >= maxSteps) {
      console.warn(`[agent] ${maxSteps} 轮工具调用已经用完，根据执行记录总结`)
      let summary = last.text
      try {
        const result = streamText({
          model,
          system: buildStepLimitSummaryPrompt(buildStepTranscript(steps), now, background, plan),
          // 只带对话的文字：部分服务商不接受没有工具定义、却带着工具调用的历史消息
          messages: dialog,
          temperature: 0,
          abortSignal,
        })
        await followProgress(result.fullStream, {
          skillsLabel: () => '正在总结执行结果',
          setStatus: options.setStatus,
          onEvent,
          stepOffset: steps.length,
          summary: true,
        })
        summary = (await result.text).trim() || summary
      }
      catch (error) {
        if (abortSignal?.aborted) throw error
        // 总结失败时，角色扮演阶段仍然可以根据工具调用的结果回复
        console.warn('[agent] 轮数用完后总结失败：', errorMessage(error))
      }
      return withPlan({ skills: loadedSkills(), toolCalls, displays, summary, stepLimitReached: true })
    }
    return withPlan({ skills: loadedSkills(), toolCalls, displays, summary: last?.text ?? '' })
  }
  catch (error) {
    if (abortSignal?.aborted) throw error
    return withPlan({ skills: loadedSkills(), toolCalls, displays, summary: '', error: errorMessage(error) })
  }
}

/** 直接调用指定工具（不经过 LLM 选择工具），结果同样交给角色扮演阶段润色 */
export async function executeDirectCall(options: AgentRunOptions, call: DirectToolCall): Promise<AgentResult> {
  const { messages, skills, onEvent, abortSignal } = options

  const skill = skills.find((s) => s.id === call.skillId)
  if (!skill) throw new Error(`技能 ${call.skillId} 未启用`)
  const tool = skill.tools[call.toolName]
  if (!tool?.execute) throw new Error(`技能 ${call.skillId} 中没有可执行的工具 ${call.toolName}`)

  onEvent?.({ type: 'skills-loaded', skills: [skill] })
  const toolCallId = `direct-${Date.now()}`
  onEvent?.({ type: 'tool-call', toolCallId, toolName: call.toolName, input: call.input })

  const record: ToolCallRecord = { toolName: call.toolName, input: call.input }
  const displays: ToolDisplay[] = []
  try {
    const context = createSkillContext(options)
    const result = tool.execute(call.input, {
      toolCallId,
      messages,
      abortSignal,
      experimental_context: context,
    })
    // execute 也可以是流式返回的异步迭代器，此时以最后一个值为结果
    let output: unknown
    if (result && typeof result === 'object' && Symbol.asyncIterator in result) {
      for await (const value of result as AsyncIterable<unknown>) output = value
    }
    else {
      output = await result
    }
    record.output = output
    const display = extractDisplay(output)
    if (display) displays.push(display)
  }
  catch (error) {
    if (abortSignal?.aborted) throw error
    record.error = errorMessage(error)
  }

  onEvent?.({ type: 'tool-result', toolCallId, record })
  return { skills: [skill], toolCalls: [record], displays, summary: '' }
}
