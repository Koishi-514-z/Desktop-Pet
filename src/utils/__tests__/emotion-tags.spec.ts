import { describe, expect, it } from 'vitest'
import { EMOTION_TAG_GROUPS, formatEmotionTagList, stripEmotionTags, supportsEmotionTags } from '@/utils/emotion-tags'

describe('情绪标签', () => {
  it('显示时去掉标签，连同多余的空格', () => {
    expect(stripEmotionTags('[happy]今天天气真好！')).toBe('今天天气真好！')
    expect(stripEmotionTags('这个嘛……[short pause]还是算了吧。[sighs]')).toBe('这个嘛……还是算了吧。')
    expect(stripEmotionTags('[sighs] Fine. I think [pause] you are right [laughs].')).toBe('Fine. I think you are right.')
    expect(stripEmotionTags('[ Happy ]嗯。[Clears  Throat]')).toBe('嗯。')
    // 方括号里不是英文单词的内容原样保留
    expect(stripEmotionTags('见第[1]条，[注]')).toBe('见第[1]条，[注]')
  })

  it('流式输出时去掉末尾没接收完整的半截标签', () => {
    expect(stripEmotionTags('好呀[sho', true)).toBe('好呀')
    expect(stripEmotionTags('好呀[short pa', true)).toBe('好呀')
    expect(stripEmotionTags('好呀[', true)).toBe('好呀')
    expect(stripEmotionTags('好呀[sho')).toBe('好呀[sho')
    expect(stripEmotionTags('见第[1', true)).toBe('见第[1')
  })

  it('只有理解标签的语音合成服务商原样收到标签', () => {
    expect(supportsEmotionTags({ protocol: 'fish-audio', selectedModelId: '' })).toBe(true)
    expect(supportsEmotionTags({ protocol: 'elevenlabs', selectedModelId: 'eleven_v3' })).toBe(true)
    expect(supportsEmotionTags({ protocol: 'elevenlabs', selectedModelId: 'eleven_v4_turbo' })).toBe(true)
    expect(supportsEmotionTags({ protocol: 'elevenlabs', selectedModelId: 'eleven_multilingual_v2' })).toBe(false)
    expect(supportsEmotionTags({ protocol: 'minimax', selectedModelId: 'speech-2.8-hd' })).toBe(false)
    expect(supportsEmotionTags({ protocol: 'openai', selectedModelId: 'gpt-4o-mini-tts' })).toBe(false)
  })

  it('提示词中的词表列出全部标签', () => {
    const list = formatEmotionTagList()
    const tags = EMOTION_TAG_GROUPS.flatMap((group) => group.tags)
    expect(tags).toHaveLength(40)
    for (const { tag, description } of tags) expect(list).toContain(`- [${tag}]：${description}`)
    for (const { title } of EMOTION_TAG_GROUPS) expect(list).toContain(`${title}：`)
  })
})
