import type { StepResult, TextStreamPart, ToolSet } from 'ai'
import type { AgentResult, AgentRunOptions, DirectToolCall, Skill, SkillContext, ToolCallRecord, ToolDisplay } from '@/agent/types'
import { stepCountIs, streamText, tool } from 'ai'
import { z } from 'zod'
import { extractDisplay } from '@/agent/context'
import { buildExecutorSystemPrompt, TRUNCATED_OUTPUT_NOTE } from '@/agent/prompts'
import { errorMessage, recentMessages } from '@/agent/utils'

// 工具执行阶段参考的最近消息条数
const EXECUTOR_CONTEXT_SIZE = 10
// 单次执行最多进行的 LLM 调用轮数（每轮可调用若干工具），防止死循环。
// 需要留出余量：如识别图片 → 加载技能 → 读取文件 → 修改文件 → 出错后修正再运行
const MAX_STEPS = 10
// 输出超过模型的长度上限、工具调用没有写完时，提醒精简后重试的次数
const MAX_TRUNCATION_RETRIES = 1
// 工具参数（如代码）写到这么多字时开始显示编写进度
const PROGRESS_MIN_CHARS = 200
// 加载其他技能的工具名
export const LOAD_SKILLS_TOOL = 'load_skills'

/**
 * 跟随流式输出更新界面上的进度：模型思考、编写较长的工具参数（如一段代码）可能要几分钟，
 * 显示进度以免看起来像卡住了。同时取出流中的错误（流出错时 steps 只会报「没有输出」）
 */
async function followProgress(stream: AsyncIterable<TextStreamPart<ToolSet>>, options: {
  skillsLabel: () => string
  setStatus?: (status: string) => void
  stepOffset: number
}) {
  const { skillsLabel, setStatus } = options
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
        break
      case 'reasoning-delta':
        setStatus?.(`${skillsLabel()}（思考中…）`)
        break
      case 'tool-input-delta': {
        const length = (inputLengths.get(part.id) ?? 0) + part.delta.length
        inputLengths.set(part.id, length)
        if (length >= PROGRESS_MIN_CHARS) setStatus?.(`${skillsLabel()}（正在编写，已写 ${length} 字）`)
        break
      }
      case 'finish-step':
        console.debug(`[agent] 第 ${step + 1} 步：${part.finishReason}，输出 ${part.usage.outputTokens ?? '?'} tokens，用时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`)
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
  const { model, visionModel, abortSignal, requestPermission, attachImages, setStatus } = options
  return { model, visionModel: visionModel ?? model, abortSignal, requestPermission, attachImages, setStatus }
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
 * 「加载技能」工具：意图识别只在开始时进行一次，但执行过程中可能发现还需要其他技能——
 * 例如用户截图发来一段要求，读出图片内容后才知道要写 Word 文档。此时由 LLM 调用这个工具加载技能，
 * 之后的步骤中就可以使用它们的工具（使用说明加入系统提示）
 */
function createLoadSkillsTool(available: Skill[], loaded: Map<string, Skill>, onLoaded: (skills: Skill[]) => void) {
  return tool({
    description: '加载「其他可用技能」中的技能。执行过程中发现还需要这些技能的能力时调用，加载后就可以使用它们的工具',
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
 * 阶段二：工具执行。由 LLM 根据已激活技能的说明自主调用工具（可多轮），并总结执行结果。
 * options.skills 为所有可用的技能，selected 为意图识别选中的技能；执行中可以通过 load_skills 加载其他技能
 */
export async function executeSkills(options: AgentRunOptions, selected: Skill[] = options.skills): Promise<AgentResult> {
  const { model, messages, skills: available, onEvent, abortSignal } = options
  const loaded = new Map(selected.map((skill) => [skill.id, skill]))
  const toolCalls: ToolCallRecord[] = []
  const displays: ToolDisplay[] = []
  const recordedIds = new Set<string>()
  const context = createSkillContext(options)
  const loadedSkills = () => [...loaded.values()]
  const otherSkills = () => available.filter((skill) => !loaded.has(skill.id))

  const loadSkills = createLoadSkillsTool(available, loaded, () => {
    onEvent?.({ type: 'routed', decision: { skillIds: [...loaded.keys()], reason: '执行中加载了技能' }, skills: loadedSkills() })
  })
  // 所有可用技能的工具都交给 streamText，每一步只启用已加载技能的工具
  const tools: ToolSet = { ...collectTools(available), [LOAD_SKILLS_TOOL]: loadSkills }
  const activeTools = () => [
    ...Object.keys(collectTools(loadedSkills())),
    ...(otherSkills().length ? [LOAD_SKILLS_TOOL] : []),
  ]

  try {
    // 背景信息准备失败不影响执行
    const background = await Promise.resolve(options.background).catch(() => '')
    const now = new Date()
    // truncated：之前的输出因为超过长度上限被截断过，提醒模型精简
    const system = (truncated: boolean) => [
      buildExecutorSystemPrompt(loadedSkills(), now, background, otherSkills()),
      truncated ? TRUNCATED_OUTPUT_NOTE : '',
    ].filter(Boolean).join('\n\n')

    let history = recentMessages(messages, EXECUTOR_CONTEXT_SIZE)
    const steps: StepResult<ToolSet>[] = []
    let truncated = false
    for (let retries = 0; ; retries++) {
      const result = streamText({
        model,
        system: system(truncated),
        messages: history,
        tools,
        activeTools: activeTools(),
        // 每一步开始前按已加载的技能更新系统提示与可用的工具；上一步被截断时提醒精简
        prepareStep: ({ steps: previous }) => {
          if (previous.at(-1)?.finishReason === 'length') truncated = true
          return { system: system(truncated), activeTools: activeTools() }
        },
        stopWhen: stepCountIs(MAX_STEPS - steps.length),
        temperature: 0,
        abortSignal,
        experimental_context: context,
        experimental_onToolCallStart: ({ toolCall }) => {
          onEvent?.({ type: 'tool-call', toolName: toolCall.toolName, input: toolCall.input })
        },
        experimental_onToolCallFinish: (event) => {
          // 加载技能只是执行过程中的一步，不作为工具调用的结果交给角色扮演阶段
          if (event.toolCall.toolName === LOAD_SKILLS_TOOL && event.success) {
            recordedIds.add(event.toolCall.toolCallId)
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
          onEvent?.({ type: 'tool-result', record })
        },
      })

      await followProgress(result.fullStream, {
        skillsLabel: () => `正在使用技能：${loadedSkills().map((skill) => skill.name).join('、')}`,
        setStatus: options.setStatus,
        stepOffset: steps.length,
      })
      const attempt = await result.steps
      steps.push(...attempt)

      // 输出超过长度上限时，OpenAI 兼容的接口会丢弃没写完的工具调用，执行就此结束。
      // 这时带着之前的步骤与精简的提醒重新生成一次（只重试一次，避免长时间卡住）
      const last = attempt.at(-1)
      if (last?.finishReason !== 'length' || retries >= MAX_TRUNCATION_RETRIES || steps.length >= MAX_STEPS) break
      console.warn('[agent] 输出超过了模型的长度上限，没有写完，提醒精简后重试')
      truncated = true
      history = [...history, ...(attempt.at(-2)?.response.messages ?? [])]
    }

    // 参数校验失败、调用了不存在的工具等情况不会执行工具，也就不会触发上面的回调，这里从步骤记录中补上
    for (const part of steps.flatMap((step) => step.content)) {
      if (part.type !== 'tool-error' || recordedIds.has(part.toolCallId)) continue
      toolCalls.push({ toolName: part.toolName, input: part.input, error: errorMessage(part.error) })
    }

    const last = steps.at(-1)
    if (last?.finishReason === 'length' && last.toolCalls.length === 0) {
      return {
        skills: loadedSkills(),
        toolCalls,
        displays,
        summary: last.text,
        error: '模型的输出超过了单次输出的长度上限，内容没有写完，精简后重试仍然不够。可以把任务拆成几部分分别完成（如先做前几页），或者换用输出上限更高的模型',
      }
    }
    return { skills: loadedSkills(), toolCalls, displays, summary: last?.text ?? '' }
  }
  catch (error) {
    if (abortSignal?.aborted) throw error
    return { skills: loadedSkills(), toolCalls, displays, summary: '', error: errorMessage(error) }
  }
}

/** 直接调用指定工具（不经过 LLM 选择工具），结果同样交给角色扮演阶段润色 */
export async function executeDirectCall(options: AgentRunOptions, call: DirectToolCall): Promise<AgentResult> {
  const { messages, skills, onEvent, abortSignal } = options

  const skill = skills.find((s) => s.id === call.skillId)
  if (!skill) throw new Error(`技能 ${call.skillId} 未启用`)
  const tool = skill.tools[call.toolName]
  if (!tool?.execute) throw new Error(`技能 ${call.skillId} 中没有可执行的工具 ${call.toolName}`)

  onEvent?.({ type: 'routed', decision: { skillIds: [skill.id], reason: '直接调用' }, skills: [skill] })
  onEvent?.({ type: 'tool-call', toolName: call.toolName, input: call.input })

  const record: ToolCallRecord = { toolName: call.toolName, input: call.input }
  const displays: ToolDisplay[] = []
  try {
    const context = createSkillContext(options)
    const result = tool.execute(call.input, {
      toolCallId: `direct-${Date.now()}`,
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

  onEvent?.({ type: 'tool-result', record })
  return { skills: [skill], toolCalls: [record], displays, summary: '' }
}
