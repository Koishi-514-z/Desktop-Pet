import type { Provider } from '@/stores/providers'

/**
 * 情绪标签：桌宠在回复中插入的、用方括号括起来的英文标签，如 [happy]、[laughs]、[short pause]。
 *
 * - 语音合成：支持标签的服务商（Fish Audio、ElevenLabs v3 / v4）原样收到标签，据此调整语气、发出笑声、停顿；
 *   其他服务商收到的文字去掉了标签，免得把标签念出来（见 supportsEmotionTags）；
 * - 表情与动作：随机播放 Live2D 模型上带有同名标签（如 happy、giggles）的一个表情或动作；
 * - 显示：对话框与字幕中去掉所有标签（见 stripEmotionTags）。
 */

export interface EmotionTag {
  /** 标签名：英文小写，单词之间一个空格 */
  tag: string
  description: string
}

export interface EmotionTagGroup {
  title: string
  tags: EmotionTag[]
}

// 桌宠可以使用的标签（写进系统提示词）
export const EMOTION_TAG_GROUPS: EmotionTagGroup[] = [
  {
    title: '情绪与语气',
    tags: [
      { tag: 'happy', description: '开心、愉悦' },
      { tag: 'excited', description: '兴奋、激动' },
      { tag: 'cheerful', description: '活泼、开朗' },
      { tag: 'sad', description: '悲伤、低落' },
      { tag: 'worried', description: '担忧、不安' },
      { tag: 'angry', description: '生气、愤怒' },
      { tag: 'annoyed', description: '不满、烦躁' },
      { tag: 'surprised', description: '惊讶、意外' },
      { tag: 'confused', description: '困惑、不解' },
      { tag: 'thoughtful', description: '思考、若有所思' },
      { tag: 'curious', description: '好奇' },
      { tag: 'shy', description: '害羞、腼腆' },
      { tag: 'embarrassed', description: '尴尬、难为情' },
      { tag: 'playful', description: '俏皮、调皮' },
      { tag: 'sarcastic', description: '调侃、讽刺' },
      { tag: 'gentle', description: '温柔、柔和' },
      { tag: 'serious', description: '认真、严肃' },
      { tag: 'calm', description: '平静、沉稳' },
      { tag: 'relieved', description: '如释重负' },
      { tag: 'hesitant', description: '犹豫、迟疑' },
      { tag: 'sympathetic', description: '关切、同情' },
    ],
  },
  {
    title: '非语言声音',
    tags: [
      { tag: 'laughs', description: '笑出声' },
      { tag: 'giggles', description: '轻笑、咯咯笑' },
      { tag: 'chuckles', description: '低声轻笑' },
      { tag: 'sighs', description: '叹气' },
      { tag: 'gasps', description: '惊讶地吸气' },
      { tag: 'exhales', description: '轻轻呼气' },
      { tag: 'clears throat', description: '清嗓子' },
      { tag: 'yawns', description: '打哈欠' },
      { tag: 'sniffles', description: '轻轻抽鼻子' },
      { tag: 'sobs', description: '抽泣' },
    ],
  },
  {
    title: '语音表达方式',
    tags: [
      { tag: 'whispers', description: '低声耳语' },
      { tag: 'shouts', description: '大声喊叫' },
      { tag: 'softly', description: '轻柔地说' },
      { tag: 'slowly', description: '缓慢地说' },
      { tag: 'quickly', description: '快速地说' },
      { tag: 'emphasizes', description: '强调接下来的内容' },
    ],
  },
  {
    title: '节奏与停顿',
    tags: [
      { tag: 'short pause', description: '短暂停顿' },
      { tag: 'pause', description: '自然停顿' },
      { tag: 'long pause', description: '较长时间的停顿' },
    ],
  },
]

// 一个标签：方括号中的一个或几个英文单词（以空格隔开），如 [happy]、[short pause]。
// 大小写不限，括号内侧可以有空格；不在词表里的英文单词同样算作标签（不显示，也不会念出来），
// 方括号里有数字、中文等的内容（如 [1]、[注]）不算
const TAG_PATTERN = String.raw`\[\s*([a-z]+(?:\s+[a-z]+)*)\s*\]`

/** 匹配一个标签，捕获其中的标签名 */
export const EMOTION_TAG_REGEX = new RegExp(TAG_PATTERN, 'i')

// 去掉标签时连同两边的空格一起去掉（见 stripEmotionTags）
const STRIP_REGEX = new RegExp(String.raw`[ \t]*${TAG_PATTERN}[ \t]*`, 'gi')

// 流式输出时文本末尾尚未接收完整的标签，如 "["、"[hap"、"[short pa"
// （单词之间必须有空格，免得一长串字母有很多种切分方法，回溯太多）
const PARTIAL_TAG_AT_END_REGEX = /\[\s*(?:[a-z]+(?:\s+[a-z]+)*)?\s*$/i

/** 标签名统一为英文小写、单词之间一个空格，如 "Short  Pause" → "short pause" */
export function normalizeEmotionTag(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * 去掉文本中的情绪标签，供对话框、字幕显示与不支持标签的语音合成使用。
 * 标签两边原本都有空格时（如英文 "I think [pause] you're right"）留下一个空格，否则连同空格一起去掉。
 * streaming 为 true 时，一并去掉末尾还没接收完整的半截标签
 */
export function stripEmotionTags(text: string, streaming = false): string {
  let result = text.replace(STRIP_REGEX, (match: string, _name: string, offset: number, whole: string) => {
    const spaced = /^[ \t]/.test(match) && /[ \t]$/.test(match)
    const inside = offset > 0 && offset + match.length < whole.length
    return spaced && inside ? ' ' : ''
  })
  if (streaming) result = result.replace(PARTIAL_TAG_AT_END_REGEX, '')
  return result
}

/**
 * 语音合成服务商能否理解方括号里的标签：
 * Fish Audio 的 S2 及之后的模型（列出的模型都是）、ElevenLabs 的 Eleven v3 与 v4 系列。
 * 其他服务商（及 ElevenLabs 的旧模型）会把标签原样念出来，合成前要去掉
 */
export function supportsEmotionTags(provider: Pick<Provider, 'protocol' | 'selectedModelId'>): boolean {
  switch (provider.protocol) {
    case 'fish-audio':
      return true
    case 'elevenlabs':
      return /^eleven_v[3-9]/.test(provider.selectedModelId)
    default:
      return false
  }
}

/** 系统提示词中的标签词表：按类别列出每个标签与说明 */
export function formatEmotionTagList(): string {
  return EMOTION_TAG_GROUPS
    .map((group) => `${group.title}：\n${group.tags.map(({ tag, description }) => `- [${tag}]：${description}`).join('\n')}`)
    .join('\n\n')
}
