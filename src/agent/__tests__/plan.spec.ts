import type { PlanStep } from '@/agent/plan'
import type { AgentResult } from '@/agent/types'
import { describe, expect, it } from 'vitest'
import { describeProgress, formatPlan, planFromInput, planProgress } from '@/agent/plan'
import { buildAgentContextPrompt } from '@/agent/prompts'

const steps: PlanStep[] = [
  { title: '查看目录结构', status: 'done' },
  { title: '阅读关键文件', status: 'in_progress' },
  { title: '画架构图', status: 'skipped' },
  { title: '总结架构', status: 'pending' },
]

describe('执行计划', () => {
  it('进度不计入跳过的步骤', () => {
    expect(planProgress(steps)).toEqual({ done: 1, total: 3 })
    expect(describeProgress(steps)).toBe('完成 1/3 步')
  })

  it('整理成交给模型的文字', () => {
    expect(formatPlan(steps)).toBe('1. [已完成] 查看目录结构\n2. [进行中] 阅读关键文件\n3. [已跳过] 画架构图\n4. [未开始] 总结架构')
  })

  it('从工具参数中取出计划，格式不对时不取', () => {
    expect(planFromInput({ steps })).toEqual(steps)
    expect(planFromInput({ steps: [{ title: '写周报', status: 'started' }] })).toBeUndefined()
    expect(planFromInput({})).toBeUndefined()
    expect(planFromInput(null)).toBeUndefined()
  })

  it('交给角色扮演阶段的执行结果中列出计划的完成情况', () => {
    const result: AgentResult = { skills: [], toolCalls: [], displays: [], summary: '看完了两个文件', plan: steps }
    expect(buildAgentContextPrompt(result)).toContain('## 执行计划\n1. [已完成] 查看目录结构\n2. [进行中] 阅读关键文件')
  })
})
