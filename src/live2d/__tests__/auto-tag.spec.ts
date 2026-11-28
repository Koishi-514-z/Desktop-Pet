import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'

// 渲染需要 WebGL 与 Live2D 运行库，这里直接给出每个表情的对比图（空字符串表示和平时看不出区别）
const snapshots = vi.hoisted(() => ({ images: {} as Record<string, string> }))
vi.mock('@/live2d/snapshot', () => ({
  renderExpressionSnapshots: vi.fn(async (_url: string, names: string[], options: { onProgress?: (done: number, total: number) => void }) => {
    names.forEach((_, index) => options.onProgress?.(index + 1, names.length))
    return names.map((name) => ({ name, image: snapshots.images[name] ?? '' }))
  }),
}))

import { autoTagExpressions, buildAutoTagSystemPrompt, parseAutoTagResult } from '@/live2d/auto-tag'

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

/** 按图片内容回答的视觉模型：answers 的键为图片的 base64 数据 */
function visionModel(answers: Record<string, string>) {
  return new MockLanguageModelV3({
    doGenerate: async ({ prompt }) => {
      const user = prompt.find((message) => message.role === 'user')!
      const image = (user.content as { type: string, data?: unknown }[]).find((part) => part.type === 'file')
      const answer = answers[String(image?.data)]
      if (answer === undefined) throw new Error('模型不支持图片输入')
      return { content: [{ type: 'text', text: answer }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }
    },
  })
}

describe('自动打标签', () => {
  it('解析判断结果：只保留可以选的标签，统一小写、去重，最多 3 个；格式不对时报错', () => {
    expect(parseAutoTagResult('{"tags": ["Happy", "giggles", "happy", "love", "shy", "excited"], "reason": "笑眯眯"}')).toEqual(['happy', 'giggles', 'shy'])
    expect(parseAutoTagResult('```json\n{"tags": [], "reason": "只是摘了眼镜"}\n```')).toEqual([])
    expect(() => parseAutoTagResult('看起来很开心')).toThrow('无法解析')
  })

  it('提示中列出可以选的标签，说明左右两边分别是什么', () => {
    const prompt = buildAutoTagSystemPrompt()
    expect(prompt).toContain('- happy：开心、愉悦')
    expect(prompt).toContain('- thinking：思考中（等待回复时）')
    expect(prompt).not.toContain('short pause')
    expect(prompt).toContain('左边是角色平时的样子')
  })

  it('看不出变化的表情不交给模型；识别失败的单独列出，不影响其他表情', async () => {
    snapshots.images = { smile: 'data:image/jpeg;base64,U01JTEU=', cry: 'data:image/jpeg;base64,Q1JZ', broken: 'data:image/jpeg;base64,QlJPS0VO' }
    const model = visionModel({
      'U01JTEU=': '{"tags": ["happy", "cheerful"], "reason": "笑了"}',
      Q1JZ: '{"tags": ["sad", "sobs"], "reason": "流泪"}',
    })
    const progress: string[] = []
    const result = await autoTagExpressions({
      url: '/model.model3.json',
      names: ['smile', 'watermark', 'cry', 'broken'],
      model,
      onProgress: (p) => progress.push(`${p.phase} ${p.done}/${p.total}`),
    })

    expect(result.tags).toEqual({ smile: ['happy', 'cheerful'], watermark: [], cry: ['sad', 'sobs'] })
    expect(result.unchanged).toEqual(['watermark'])
    expect(result.failed).toEqual([{ name: 'broken', error: '模型不支持图片输入' }])
    // 只有三个有变化的表情交给了模型
    expect(model.doGenerateCalls).toHaveLength(3)
    expect(progress[0]).toBe('render 1/4')
    expect(progress.at(-1)).toBe('classify 3/3')
  })

  it('取消时停止，抛出取消的原因', async () => {
    snapshots.images = { smile: 'data:image/jpeg;base64,U01JTEU=' }
    const controller = new AbortController()
    controller.abort(new DOMException('已取消', 'AbortError'))
    await expect(autoTagExpressions({ url: '/m.json', names: ['smile'], model: visionModel({}), signal: controller.signal })).rejects.toThrow()
  })
})
