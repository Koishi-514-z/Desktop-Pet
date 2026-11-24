import { tool } from 'ai'
import { z } from 'zod'

/**
 * 执行计划：需要多个步骤的任务（尤其是意图识别判断为复杂的任务），由 LLM 在开始前用 update_plan 列出 3～5 步，
 * 每完成一步再提交一次最新的完整计划。计划显示在执行过程面板里，也写入追问时参考的工具调用记录，
 * 以便用户说「继续」时从没有完成的步骤接着做。
 */

/** 制定与更新计划的工具名 */
export const PLAN_TOOL = 'update_plan'

export type PlanStatus = 'pending' | 'in_progress' | 'done' | 'skipped'

export interface PlanStep {
  title: string
  status: PlanStatus
}

const PLAN_STATUSES = ['pending', 'in_progress', 'done', 'skipped'] as const

/** 交给模型的文字中使用的状态说明 */
export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  done: '已完成',
  in_progress: '进行中',
  pending: '未开始',
  skipped: '已跳过',
}

/** 计划的进度：已完成的步数与总步数（不含跳过的步骤） */
export function planProgress(steps: PlanStep[]): { done: number, total: number } {
  const counted = steps.filter((step) => step.status !== 'skipped')
  return { done: counted.filter((step) => step.status === 'done').length, total: counted.length }
}

/** 把计划整理成交给模型的文字，如「1. [已完成] 查看目录结构」 */
export function formatPlan(steps: PlanStep[], separator = '\n'): string {
  return steps.map((step, index) => `${index + 1}. [${PLAN_STATUS_LABELS[step.status]}] ${step.title}`).join(separator)
}

/** 从 update_plan 的参数中取出计划，格式不对时返回 undefined */
export function planFromInput(input: unknown): PlanStep[] | undefined {
  const steps = (input as { steps?: unknown } | null)?.steps
  if (!Array.isArray(steps)) return undefined
  const valid = steps.filter((step): step is PlanStep =>
    typeof step?.title === 'string' && (PLAN_STATUSES as readonly unknown[]).includes(step?.status))
  return valid.length === steps.length ? valid : undefined
}

/** 「完成 2/4 步」 */
export function describeProgress(steps: PlanStep[]): string {
  const { done, total } = planProgress(steps)
  return `完成 ${done}/${total} 步`
}

/** 制定或更新计划的工具；每次提交完整的计划，onUpdate 收到最新的计划 */
export function createPlanTool(onUpdate: (steps: PlanStep[]) => void) {
  return tool({
    description: '制定或更新执行计划。需要多个步骤的任务开始前先调用一次，列出 3～5 步；之后每完成一步、或者计划需要调整时再调用，每次都提交全部步骤的最新状态',
    inputSchema: z.object({
      steps: z.array(z.object({
        title: z.string().min(1).describe('这一步要做什么，简短的一句话'),
        status: z.enum(PLAN_STATUSES).describe('pending：还没开始；in_progress：正在做；done：已完成；skipped：不再需要'),
      })).min(1).max(8).describe('完整的计划，一般 3～5 步，最后一步一般是检查结果'),
    }),
    execute: async ({ steps }) => {
      onUpdate(steps)
      const next = steps.find((step) => step.status === 'in_progress') ?? steps.find((step) => step.status === 'pending')
      return {
        progress: describeProgress(steps),
        ...(next
          ? { next: next.title, note: '完成这一步后再调用 update_plan 更新状态（可以和下一步的工具放在同一轮中调用）' }
          : { note: '计划中的步骤都已完成：确认结果没问题后总结' }),
      }
    },
  })
}
