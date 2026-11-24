import type { MergeCandidate } from '@/memory/merge'
import type { SimilarMemory } from '@/memory/types'
import { describe, expect, it } from 'vitest'
import { buildExtractionSystemPrompt, parseExtractedMemories } from '@/memory/extract'
import { parseMergeDecisions } from '@/memory/merge'

describe('记忆提取', () => {
  it('提示中鼓励多记，不确定的信息给低一些的重要程度', () => {
    const prompt = buildExtractionSystemPrompt('小桌', new Date('2026-11-24T17:00:00'))
    expect(prompt).toContain('宁可多记')
    expect(prompt).not.toContain('大多数对话都没有值得记住的信息')
    expect(prompt).not.toContain('拿不准的信息不要记录')
  })

  it('解析标准的输出', () => {
    const text = '{"memories": [{"content": "用户有一场面试", "category": "plan", "importance": 0.7, "occurredAt": "2026-11-25 14:00"}]}'
    expect(parseExtractedMemories(text)).toEqual([
      { content: '用户有一场面试', category: 'plan', importance: 0.7, occurredAt: new Date(2026, 10, 25, 14, 0).getTime() },
    ])
  })

  it('类别写成中文或识别不了、重要程度写成字符串或文字时，用识别出的值或默认值，不丢掉记忆', () => {
    const text = `{"memories": [
      {"content": "用户叫小明", "category": "用户档案", "importance": "0.9"},
      {"content": "用户喜欢猫", "category": "Preference", "importance": "高"},
      {"content": "用户最近很忙", "category": "近况"}
    ]}`
    expect(parseExtractedMemories(text)).toEqual([
      { content: '用户叫小明', category: 'profile', importance: 0.9 },
      { content: '用户喜欢猫', category: 'preference', importance: 0.5 },
      { content: '用户最近很忙', category: 'episodic', importance: 0.5 },
    ])
  })

  it('直接输出数组、记忆只写成一句话时也能识别', () => {
    expect(parseExtractedMemories('```json\n[{"content": "用户在开发一个桌宠项目", "category": "episodic"}]\n```')).toEqual([
      { content: '用户在开发一个桌宠项目', category: 'episodic', importance: 0.5 },
    ])
    expect(parseExtractedMemories('{"memories": ["用户住在杭州"]}')).toEqual([
      { content: '用户住在杭州', category: 'episodic', importance: 0.5 },
    ])
  })

  it('只跳过没有内容的条目', () => {
    expect(parseExtractedMemories('{"memories": [{"content": ""}, {"category": "plan"}, {"content": "用户周五考试", "occurredAt": 123}]}')).toEqual([
      { content: '用户周五考试', category: 'episodic', importance: 0.5 },
    ])
    expect(parseExtractedMemories('没有需要记住的信息')).toEqual([])
  })
})

describe('记忆合并', () => {
  const existing = { id: 7, content: '用户喜欢狗', category: 'preference', importance: 0.5 } as SimilarMemory
  const candidates: MergeCandidate[] = [{ fact: { content: '用户喜欢猫', category: 'preference', importance: 0.5 }, similar: [existing] }]

  it('判断为重复却引用了未知的记忆时按新增处理，不丢掉新的信息', () => {
    expect(parseMergeDecisions('{"decisions": [{"index": 1, "action": "skip", "target": 99}]}', candidates)).toEqual([{ action: 'add' }])
    expect(parseMergeDecisions('{"decisions": [{"index": 1, "action": "skip"}]}', candidates)).toEqual([{ action: 'add' }])
    expect(parseMergeDecisions('{"decisions": [{"index": 1, "action": "skip", "target": 7}]}', candidates)).toEqual([{ action: 'skip', target: 7 }])
  })
})
