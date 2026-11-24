import type { ModelMessage, StepResult, ToolResultPart, ToolSet } from 'ai'
import type { AgentResult } from '@/agent/types'
import { describeProgress, formatPlan } from '@/agent/plan'
import { errorMessage, stringify, summarizeInput, truncate } from '@/agent/utils'

/**
 * 控制交给模型的上下文长度：
 * - 工具执行中：上下文超过预算时，把较早的工具结果精简为摘要（保留路径、数量等要点，省略长内容）；
 * - 每一轮结束后：把工具调用整理成紧凑的记录保存在回复上，追问时交给意图识别与工具执行阶段；
 * - 工具调用的轮数用完时：把执行过程整理成文字记录，交给模型总结。
 */

// ===== 精简数据 =====

export interface CompactOptions {
  /** 超过这么多字的字符串会被省略 */
  maxString?: number
  /** 数组最多保留的项数 */
  maxItems?: number
  /** 最多展开的嵌套层数 */
  maxDepth?: number
  /** 省略长字符串时换成的说明 */
  omitted?: (length: number) => string
  /** 不保留的字段（如已经单独展示过的 display） */
  omitKeys?: string[]
}

const COMPACT_DEFAULTS: Required<CompactOptions> = {
  maxString: 400,
  maxItems: 10,
  maxDepth: 4,
  omitted: (length) => `（共 ${length} 字，已省略）`,
  omitKeys: [],
}

/** 精简一个值：长字符串换成字数说明，数组只保留前几项，嵌套过深的部分省略；路径、名称、数量等短字段保持原样 */
export function compactValue(value: unknown, options: CompactOptions = {}): unknown {
  const settings = { ...COMPACT_DEFAULTS, ...options }
  const walk = (item: unknown, depth: number): unknown => {
    if (typeof item === 'string') return item.length > settings.maxString ? settings.omitted(item.length) : item
    if (item === null || typeof item !== 'object') return item
    if (depth >= settings.maxDepth) return Array.isArray(item) ? `（${item.length} 项）` : '{…}'
    if (Array.isArray(item)) {
      const kept = item.slice(0, settings.maxItems).map((entry) => walk(entry, depth + 1))
      return item.length > settings.maxItems ? [...kept, `（还有 ${item.length - settings.maxItems} 项）`] : kept
    }
    return Object.fromEntries(
      Object.entries(item)
        .filter(([key, entry]) => entry !== undefined && !settings.omitKeys.includes(key))
        .map(([key, entry]) => [key, walk(entry, depth + 1)]),
    )
  }
  return walk(value, 0)
}

// ===== 工具执行中：上下文超过预算时精简较早的工具结果 =====

/**
 * 工具执行阶段交给模型的消息（不含系统提示）的长度预算，按序列化后的字数估算。
 * 大约相当于 4～8 万 tokens，适合 128K 上下文的模型；使用上下文较小的模型（如 32K）时需要调小
 */
export const CONTEXT_BUDGET = 96_000
/** 最近几轮的工具调用与结果总是保持原样 */
const KEEP_RECENT_STEPS = 2
/** 纯文本的工具结果精简后保留的开头长度 */
const IN_RUN_TEXT_LENGTH = 1000

const inRunOmitted = (length: number) => `（共 ${length} 字，上下文太长已省略，需要时重新调用工具获取）`

function compactOutput(output: ToolResultPart['output']): ToolResultPart['output'] {
  switch (output.type) {
    case 'json':
      return { ...output, value: compactValue(output.value, { omitted: inRunOmitted }) as typeof output.value }
    case 'text':
      return output.value.length > IN_RUN_TEXT_LENGTH
        ? { ...output, value: `${output.value.slice(0, IN_RUN_TEXT_LENGTH)}${inRunOmitted(output.value.length)}` }
        : output
    case 'content':
      return {
        ...output,
        value: output.value.map((part) => {
          if (part.type !== 'text') return { type: 'text' as const, text: '（图片或文件，上下文太长已省略）' }
          return part.text.length > IN_RUN_TEXT_LENGTH
            ? { ...part, text: `${part.text.slice(0, IN_RUN_TEXT_LENGTH)}${inRunOmitted(part.text.length)}` }
            : part
        }),
      }
    default:
      return output
  }
}

/** 精简一条消息中的工具结果与工具参数（如写入文件的长内容），文字保持原样 */
function compactMessage(message: ModelMessage): ModelMessage {
  if (message.role === 'tool') {
    return {
      ...message,
      content: message.content.map((part) => (part.type === 'tool-result' ? { ...part, output: compactOutput(part.output) } : part)),
    }
  }
  if (message.role === 'assistant' && Array.isArray(message.content)) {
    return {
      ...message,
      content: message.content.map((part) => (part.type === 'tool-call' ? { ...part, input: compactValue(part.input, { omitted: inRunOmitted }) } : part)),
    }
  }
  return message
}

function sizeOf(message: ModelMessage): number {
  return JSON.stringify(message).length
}

/**
 * 消息的总长度超过预算时，从最早的开始精简工具结果，直到不超过预算；最近 keepRecent 轮的工具调用保持原样。
 * 没有超过预算时原样返回。只影响这一步交给模型的消息，不会改动执行记录
 */
export function compactToolMessages(messages: ModelMessage[], budget = CONTEXT_BUDGET, keepRecent = KEEP_RECENT_STEPS): ModelMessage[] {
  let size = messages.reduce((total, message) => total + sizeOf(message), 0)
  if (size <= budget) return messages

  const toolIndexes = messages.flatMap((message, index) => (message.role === 'tool' ? [index] : []))
  if (toolIndexes.length <= keepRecent) return messages
  // 保护最近几轮：从倒数第 keepRecent 个工具结果之前、发起这些调用的那条消息开始
  const boundary = keepRecent > 0 ? toolIndexes[toolIndexes.length - keepRecent]! : messages.length
  const protectFrom = messages[boundary - 1]?.role === 'assistant' ? boundary - 1 : boundary

  const result = [...messages]
  for (let index = 0; index < protectFrom && size > budget; index++) {
    const original = result[index]!
    if (original.role !== 'tool' && original.role !== 'assistant') continue
    const compacted = compactMessage(original)
    size += sizeOf(compacted) - sizeOf(original)
    result[index] = compacted
  }
  return result
}

// ===== 每一轮结束后：工具调用的紧凑记录，供追问时参考 =====

const LOG_MAX_CALLS = 10
const LOG_VALUE_LENGTH = 240
const LOG_INPUT_LENGTH = 320
const LOG_OUTPUT_LENGTH = 480
const LOG_ERROR_LENGTH = 320
const LOG_SUMMARY_LENGTH = 1200

function describeOutput(output: unknown): string {
  if (output === undefined) return ''
  // 结果卡片已经作为对话内容保留在历史中了，这里不再重复
  const compacted = compactValue(output, { maxString: LOG_VALUE_LENGTH, maxItems: 8, omitKeys: ['display'], omitted: (length) => `（${length} 字）` })
  if (compacted && typeof compacted === 'object' && !Array.isArray(compacted) && Object.keys(compacted).length === 0) return ''
  return truncate(typeof compacted === 'string' ? compacted : JSON.stringify(compacted), LOG_OUTPUT_LENGTH)
}

/**
 * 把这一轮的工具调用整理成紧凑的记录：每次调用的技能、工具、关键参数（如路径）与简短的结果，以及执行总结。
 * 追问「第二个文件呢」「再运行一次」时，工具执行阶段可以直接使用其中的路径等信息。没有可记录的内容时返回空字符串
 */
export function buildToolLog(result: AgentResult): string {
  const skillOf = new Map(result.skills.flatMap((skill) => Object.keys(skill.tools).map((name) => [name, skill.name] as const)))
  const calls = result.toolCalls.slice(-LOG_MAX_CALLS)
  const lines = calls.map((call, index) => {
    const skill = skillOf.get(call.toolName)
    const input = summarizeInput(call.input, { valueLength: LOG_VALUE_LENGTH, totalLength: LOG_INPUT_LENGTH })
    let outcome: string
    if (call.error !== undefined) {
      outcome = `失败：${truncate(call.error, LOG_ERROR_LENGTH)}`
    }
    else {
      const output = describeOutput(call.output)
      outcome = output ? `成功：${output}` : '成功'
    }
    return `${index + 1}. ${skill ? `${skill} · ` : ''}${call.toolName}${input ? `（${input}）` : ''} → ${outcome}`
  })

  const skipped = result.toolCalls.length - calls.length
  if (skipped > 0) lines.unshift(`（更早的 ${skipped} 次调用已省略）`)
  // 执行计划的最终状态：用户说「继续」时，从没有完成的步骤接着做
  if (result.plan?.length) {
    lines.push(`执行计划（${describeProgress(result.plan)}）：${truncate(formatPlan(result.plan, '；'), LOG_SUMMARY_LENGTH)}`)
  }
  if (result.error !== undefined) lines.push(`执行出错：${truncate(result.error, LOG_ERROR_LENGTH)}`)
  else if (result.summary.trim()) lines.push(`执行总结：${truncate(result.summary.trim(), LOG_SUMMARY_LENGTH)}`)
  return lines.join('\n')
}

// ===== 轮数用完时：执行过程的文字记录，交给模型总结 =====

/** 文字记录中工具结果的总长度预算 */
export const TRANSCRIPT_BUDGET = 80_000
const TRANSCRIPT_RESULT_MIN = 800
const TRANSCRIPT_RESULT_MAX = 8000
const TRANSCRIPT_TEXT_LENGTH = 3000
const TRANSCRIPT_ERROR_LENGTH = 600

/**
 * 把执行过程整理成文字记录。总结时不再提供工具，而部分服务商不接受「没有工具定义、却带着工具调用」的历史消息，
 * 所以把工具调用与结果写成文字交给模型。工具结果按数量平均分配长度预算
 */
export function buildStepTranscript(steps: StepResult<ToolSet>[], budget = TRANSCRIPT_BUDGET): string {
  const resultCount = steps.reduce((count, step) => count + step.content.filter((part) => part.type === 'tool-result').length, 0)
  const perResult = Math.min(TRANSCRIPT_RESULT_MAX, Math.max(TRANSCRIPT_RESULT_MIN, Math.floor(budget / Math.max(1, resultCount))))

  return steps
    .map((step, index) => {
      const lines = [`## 第 ${index + 1} 轮`]
      const text = step.text.trim()
      if (text) lines.push(truncate(text, TRANSCRIPT_TEXT_LENGTH))
      for (const part of step.content) {
        if (part.type === 'tool-call') {
          lines.push(`- 调用 ${part.toolName}：${summarizeInput(part.input, { valueLength: 400, totalLength: 1000 }) || '（无参数）'}`)
        }
        else if (part.type === 'tool-result') {
          lines.push(`- ${part.toolName} 的结果：${stringify(part.output, perResult)}`)
        }
        else if (part.type === 'tool-error') {
          lines.push(`- ${part.toolName} 失败：${truncate(errorMessage(part.error), TRANSCRIPT_ERROR_LENGTH)}`)
        }
      }
      return lines.join('\n')
    })
    .join('\n\n')
}
