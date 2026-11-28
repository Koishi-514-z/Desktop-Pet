import type { LanguageModel } from 'ai'
import type { SnapshotOptions } from '@/live2d/snapshot'
import { generateText } from 'ai'
import { parseJsonObject } from '@/agent/utils'
import { AUTO_TAG_GROUPS } from '@/live2d/tags'
import { renderExpressionSnapshots } from '@/live2d/snapshot'

/**
 * 自动打标签：把模型的每个表情渲染成「平时｜这个表情」的对比图（见 live2d/snapshot.ts），
 * 交给视觉模型判断适合在表达哪些情绪时使用。这样任何导入的模型都能用上情绪标签，不需要在模型文件中手写 Tags
 */

/** 一个表情最多几个标签 */
const MAX_TAGS = 3
/** 同时交给视觉模型判断的表情数 */
const CONCURRENCY = 3

const ALLOWED_TAGS = new Set(AUTO_TAG_GROUPS.flatMap((group) => group.tags.map((tag) => tag.tag)))

export function buildAutoTagSystemPrompt(): string {
  const tagLines = AUTO_TAG_GROUPS
    .map((group) => `${group.title}：\n${group.tags.map(({ tag, description }) => `- ${tag}：${description}`).join('\n')}`)
    .join('\n\n')
  return `你在帮桌宠程序给 Live2D 角色的表情分类。图片左边是角色平时的样子，右边是同一个角色换上某个表情后的样子（只截取了有变化的部分）。请判断右边这个表情适合在角色表达哪些情绪时使用。

可以选的标签：
${tagLines}

规则：
- 根据右边相对左边的变化（眉毛、眼睛、嘴、脸红、眼泪、汗等）判断，选 0～${MAX_TAGS} 个最贴切的标签，最贴切的放在前面。
- 变化与情绪无关（如换衣服、戴眼镜、隐藏水印、只是换了个姿势或手势）或者看不出是什么情绪时，返回空数组。
- 只输出一个 JSON 对象，不要输出任何其他内容：{"tags": ["happy"], "reason": "一句话理由"}`
}

/** 解析模型的判断结果：只保留可以选的标签，最多 MAX_TAGS 个；无法解析时抛出错误 */
export function parseAutoTagResult(text: string): string[] {
  const data = parseJsonObject(text)
  if (!data || !Array.isArray(data.tags)) throw new Error('无法解析模型的判断结果')
  const tags = data.tags
    .filter((tag): tag is string => typeof tag === 'string')
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => ALLOWED_TAGS.has(tag))
  return [...new Set(tags)].slice(0, MAX_TAGS)
}

/** 判断一张对比图（JPEG data URL）中的表情适合哪些情绪标签 */
export async function classifyExpression(model: LanguageModel, image: string, abortSignal?: AbortSignal): Promise<string[]> {
  const { text } = await generateText({
    model,
    system: buildAutoTagSystemPrompt(),
    messages: [{
      role: 'user',
      content: [
        // 去掉 data URL 前缀，只保留 base64 数据
        { type: 'image', image: image.slice(image.indexOf(',') + 1), mediaType: 'image/jpeg' },
        { type: 'text', text: '请判断右边这个表情的标签。' },
      ],
    }],
    temperature: 0,
    abortSignal,
  })
  return parseAutoTagResult(text)
}

export type AutoTagProgress =
  | { phase: 'render', done: number, total: number }
  | { phase: 'classify', done: number, total: number }

export interface AutoTagResult {
  /** 判断出的标签：表情名称 → 标签（看不出情绪的为空数组） */
  tags: Record<string, string[]>
  /** 和平时的样子看不出区别、没有交给模型的表情（也记为空数组） */
  unchanged: string[]
  /** 判断失败的表情与原因，不出现在 tags 中 */
  failed: { name: string, error: string }[]
}

export interface AutoTagOptions extends Pick<SnapshotOptions, 'keepTextures'> {
  /** 模型文件（model3.json）的地址 */
  url: string
  /** 要判断的表情名称 */
  names: string[]
  /** 能看图的模型 */
  model: LanguageModel
  signal?: AbortSignal
  onProgress?: (progress: AutoTagProgress) => void
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function autoTagExpressions(options: AutoTagOptions): Promise<AutoTagResult> {
  const { url, names, model, signal, onProgress, keepTextures } = options
  const snapshots = await renderExpressionSnapshots(url, names, {
    signal,
    keepTextures,
    onProgress: (done, total) => onProgress?.({ phase: 'render', done, total }),
  })

  const result: AutoTagResult = { tags: {}, unchanged: [], failed: [] }
  const pending = snapshots.filter((snapshot) => {
    if (snapshot.image) return true
    result.tags[snapshot.name] = []
    result.unchanged.push(snapshot.name)
    return false
  })

  let done = 0
  onProgress?.({ phase: 'classify', done, total: pending.length })
  let next = 0
  const worker = async () => {
    while (next < pending.length) {
      const snapshot = pending[next++]!
      try {
        result.tags[snapshot.name] = await classifyExpression(model, snapshot.image, signal)
      }
      catch (error) {
        if (signal?.aborted) throw error
        result.failed.push({ name: snapshot.name, error: errorText(error) })
      }
      onProgress?.({ phase: 'classify', done: ++done, total: pending.length })
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker))
  return result
}
