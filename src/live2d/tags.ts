import type { Live2dExpression, Live2dModel, Live2dMotion } from '@/stores/live2d'
import type { EmotionTag } from '@/utils/emotion-tags'
import { EMOTION_TAG_GROUPS } from '@/utils/emotion-tags'

/**
 * Live2D 模型上表情、动作的情绪标签。
 *
 * 模型说到某种情绪（回复中的 [happy] 等标签）时，随机播放带有同名标签的一个表情或动作。标签有两个来源：
 * - 模型文件：model3.json 中表情、动作条目上自定义的 Tags 字段；
 * - 设置：在模型详情中手动打的，或者让视觉模型看图自动打的（见 live2d/auto-tag.ts），保存在模型的 customTags 中，
 *   优先于模型文件中的标签；清除后恢复为模型文件中的。
 */

/** 等待模型回复时播放的表情（不是模型会说出的情绪标签） */
export const THINKING_TAG = 'thinking'

export interface Live2dTagGroup {
  title: string
  tags: EmotionTag[]
}

const THINKING_GROUP: Live2dTagGroup = {
  title: '其他',
  tags: [{ tag: THINKING_TAG, description: '思考中（等待回复时）' }],
}

/** 设置中可以给表情、动作打的标签：节奏与停顿类的标签没有对应的样子，不列出 */
export const LIVE2D_TAG_GROUPS: Live2dTagGroup[] = [
  ...EMOTION_TAG_GROUPS.filter((group) => group.id !== 'rhythm'),
  THINKING_GROUP,
]

/** 自动打标签时让视觉模型从中选择的标签：能从脸上看出来的情绪与声音（笑、叹气、哭等），以及思考中 */
export const AUTO_TAG_GROUPS: Live2dTagGroup[] = [
  ...EMOTION_TAG_GROUPS.filter((group) => group.id === 'emotion' || group.id === 'sound'),
  THINKING_GROUP,
]

const DESCRIPTIONS = new Map(LIVE2D_TAG_GROUPS.flatMap((group) => group.tags).map(({ tag, description }) => [tag, description]))

/** 标签的简短中文名，如 happy → 开心；不认识的标签（如模型文件中的旧标签 love）原样显示 */
export function tagLabel(tag: string): string {
  return DESCRIPTIONS.get(tag)?.split(/[、（]/)[0] ?? tag
}

/** 标签的说明，如「happy：开心、愉悦」 */
export function tagTitle(tag: string): string {
  const description = DESCRIPTIONS.get(tag)
  return description ? `${tag}：${description}` : tag
}

/** 动作在 customTags 中的键：动作组与序号 */
export function motionKey(motion: Pick<Live2dMotion, 'group' | 'index'>): string {
  return `${motion.group}:${motion.index}`
}

type TaggedModel = Pick<Live2dModel, 'customTags'> | undefined

/** 表情的情绪标签：设置中打过的优先，否则用模型文件中的 */
export function expressionTags(model: TaggedModel, expression: Pick<Live2dExpression, 'name' | 'tags'>): string[] {
  return model?.customTags?.expressions?.[expression.name] ?? expression.tags ?? []
}

/** 动作的情绪标签：设置中打过的优先，否则用模型文件中的 */
export function motionTags(model: TaggedModel, motion: Pick<Live2dMotion, 'group' | 'index' | 'tags'>): string[] {
  return model?.customTags?.motions?.[motionKey(motion)] ?? motion.tags ?? []
}

/** 是否在设置中改过（不是模型文件中的） */
export function hasCustomExpressionTags(model: TaggedModel, name: string): boolean {
  return !!model?.customTags?.expressions && name in model.customTags.expressions
}

export function hasCustomMotionTags(model: TaggedModel, motion: Pick<Live2dMotion, 'group' | 'index'>): boolean {
  return !!model?.customTags?.motions && motionKey(motion) in model.customTags.motions
}
