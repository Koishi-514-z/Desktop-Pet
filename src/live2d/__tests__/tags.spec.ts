import { describe, expect, it } from 'vitest'
import { AUTO_TAG_GROUPS, expressionTags, hasCustomExpressionTags, hasCustomMotionTags, LIVE2D_TAG_GROUPS, motionKey, motionTags, tagLabel, tagTitle, THINKING_TAG } from '@/live2d/tags'

describe('表情、动作的情绪标签', () => {
  const expression = { name: 'smile', tags: ['happy', 'love'] }
  const motion = { group: 'TapBody', index: 2, tags: ['excited'] }

  it('设置中打过的标签优先，否则用模型文件中的，都没有时为空', () => {
    expect(expressionTags(undefined, expression)).toEqual(['happy', 'love'])
    expect(expressionTags({ customTags: { expressions: { smile: ['giggles'] } } }, expression)).toEqual(['giggles'])
    // 设置中清空了（空数组）也算打过
    expect(expressionTags({ customTags: { expressions: { smile: [] } } }, expression)).toEqual([])
    expect(expressionTags({}, { name: 'sad' })).toEqual([])

    expect(motionKey(motion)).toBe('TapBody:2')
    expect(motionTags({ customTags: { motions: { 'TapBody:2': ['laughs'] } } }, motion)).toEqual(['laughs'])
    expect(motionTags({ customTags: { motions: { 'TapBody:1': ['laughs'] } } }, motion)).toEqual(['excited'])

    expect(hasCustomExpressionTags({ customTags: { expressions: { smile: [] } } }, 'smile')).toBe(true)
    expect(hasCustomExpressionTags({ customTags: {} }, 'smile')).toBe(false)
    expect(hasCustomMotionTags({ customTags: { motions: { 'TapBody:2': [] } } }, motion)).toBe(true)
  })

  it('可以打的标签不含停顿类，包括思考中；自动打标签只用看得出来的情绪与声音', () => {
    const all = LIVE2D_TAG_GROUPS.flatMap((group) => group.tags.map((tag) => tag.tag))
    expect(all).toContain('happy')
    expect(all).toContain('whispers')
    expect(all).toContain(THINKING_TAG)
    expect(all).not.toContain('short pause')

    const auto = AUTO_TAG_GROUPS.flatMap((group) => group.tags.map((tag) => tag.tag))
    expect(auto).toContain('giggles')
    expect(auto).toContain(THINKING_TAG)
    expect(auto).not.toContain('whispers')
  })

  it('显示用的简短中文名与说明；不认识的标签原样显示', () => {
    expect(tagLabel('happy')).toBe('开心')
    expect(tagLabel('thinking')).toBe('思考中')
    expect(tagLabel('clears throat')).toBe('清嗓子')
    expect(tagLabel('smug')).toBe('smug')
    expect(tagTitle('sad')).toBe('sad：悲伤、低落')
    expect(tagTitle('smug')).toBe('smug')
  })
})
