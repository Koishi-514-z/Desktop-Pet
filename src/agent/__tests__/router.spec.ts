import { describe, expect, it } from 'vitest'
import { COMPLEX_MAX_STEPS, DEFAULT_MAX_STEPS, stepBudget } from '@/agent/executor'
import { parseRouteDecision } from '@/agent/router'

describe('意图识别结果', () => {
  it('只区分闲聊与任务，并读出任务是否复杂', () => {
    const decision = parseRouteDecision('{"task": true, "complex": true, "reason": "要了解整个项目"}', true)
    expect(decision).toEqual({ task: true, reason: '要了解整个项目', complex: true })
    expect(stepBudget(decision)).toBe(COMPLEX_MAX_STEPS)

    expect(parseRouteDecision('{"task": false, "complex": true, "reason": "闲聊"}', true)).toEqual({ task: false, reason: '闲聊' })
    expect(stepBudget(parseRouteDecision('{"task": true, "reason": "找文件"}', true))).toBe(DEFAULT_MAX_STEPS)
  })

  it('兼容代码块包裹、布尔值写成字符串的输出', () => {
    expect(parseRouteDecision('```json\n{"task": "true", "complex": "false", "reason": "查天气"}\n```', false)).toEqual({ task: true, reason: '查天气' })
  })

  it('无法解析时以 fallback 为准：用户的消息宁可当成任务，图片中的要求宁可不执行', () => {
    expect(parseRouteDecision('我觉得这是一个任务', true)).toMatchObject({ task: true })
    expect(parseRouteDecision('{"skills": ["files"]}', true)).toMatchObject({ task: true })
    expect(parseRouteDecision('看不出来', false)).toMatchObject({ task: false })
  })
})
