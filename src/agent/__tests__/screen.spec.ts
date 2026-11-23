import type { PermissionRequest } from '@/agent/types'
import type { ImageRef, StoredImage } from '@/utils/images'
import type { WindowInfo } from '@/utils/screen'
import { MockLanguageModelV3 } from 'ai/test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runAgent } from '@/agent'
import { SCREEN_CAPTURE_PERMISSION, screenSkill } from '@/agent/skills/screen'

// 模拟桌面端：目标窗口与截图结果
const screen = vi.hoisted(() => ({
  target: null as WindowInfo | null,
  captured: [] as number[],
}))

vi.mock('@/utils/screen', () => ({
  getTargetWindow: async () => screen.target,
  captureWindow: async (id: number) => {
    screen.captured.push(id)
    return 'data:image/png;base64,SCREEN'
  },
}))

// 用内存代替 IndexedDB
const stored = vi.hoisted(() => new Map<string, StoredImage>())

vi.mock('@/utils/images', () => ({
  addImage: async (dataUrl: string): Promise<ImageRef> => {
    const id = `img_${stored.size + 1}`
    stored.set(id, { id, dataUrl, mediaType: 'image/png', width: 800, height: 600, createdAt: 0 })
    return { id, width: 800, height: 600 }
  },
  loadImage: async (id: string) => stored.get(id),
}))

type GenerateResult = Awaited<ReturnType<MockLanguageModelV3['doGenerate']>>
type Content = GenerateResult['content'][number]

function result(content: Content[], finish: 'stop' | 'tool-calls' = 'stop'): GenerateResult {
  return {
    content,
    finishReason: { unified: finish, raw: undefined },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  }
}

const text = (value: string) => result([{ type: 'text', text: value }])
const call = (toolName: string, input: unknown) =>
  result([{ type: 'tool-call', toolCallId: 'call-1', toolName, input: JSON.stringify(input) }], 'tool-calls')

function scriptedModel(...results: GenerateResult[]) {
  let index = 0
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const next = results[index++]
      if (!next) throw new Error('模型调用次数超出预期')
      return next
    },
  })
}

const user = (content: string) => ({ role: 'user' as const, content })
const input = { reason: '看看程序报了什么错', question: '程序为什么运行不了' }

function lookAtScreen(options: {
  visionModel?: MockLanguageModelV3
  requestPermission?: (request: PermissionRequest) => Promise<boolean>
  attachImages?: (images: ImageRef[]) => void
}) {
  return runAgent({
    model: scriptedModel(),
    messages: [user('我这个程序为什么运行不了？')],
    skills: [screenSkill],
    directCall: { skillId: 'screen', toolName: 'look_at_screen', input },
    ...options,
  })
}

beforeEach(() => {
  screen.target = { id: 42, title: 'main.py - Visual Studio Code', appName: 'Code' }
  screen.captured = []
  stored.clear()
})

describe('看屏幕', () => {
  it('用户允许后截取目标窗口，附加到消息上并交给视觉模型分析', async () => {
    const visionModel = scriptedModel(text('报错 ModuleNotFoundError，需要 pip install requests'))
    const requests: PermissionRequest[] = []
    const attached: ImageRef[] = []

    const res = await lookAtScreen({
      visionModel,
      requestPermission: async (request) => {
        requests.push(request)
        return true
      },
      attachImages: (images) => attached.push(...images),
    })

    // 授权请求中带有 LLM 给出的理由与目标窗口
    expect(requests).toEqual([expect.objectContaining({
      kind: SCREEN_CAPTURE_PERMISSION,
      reason: '看看程序报了什么错',
      target: 'main.py - Visual Studio Code',
    })])
    expect(screen.captured).toEqual([42])
    expect(attached).toEqual([{ id: 'img_1', width: 800, height: 600 }])

    const prompt = JSON.stringify(visionModel.doGenerateCalls[0]!.prompt)
    expect(prompt).toContain('程序为什么运行不了')
    expect(prompt).toContain('SCREEN')
    expect(res?.displays).toEqual([{ title: '屏幕分析', content: '报错 ModuleNotFoundError，需要 pip install requests', format: 'text' }])
  })

  it('用户拒绝时不截图，并把拒绝告知角色', async () => {
    const visionModel = scriptedModel()
    const res = await lookAtScreen({ visionModel, requestPermission: async () => false })

    expect(screen.captured).toEqual([])
    expect(visionModel.doGenerateCalls).toHaveLength(0)
    expect(res?.toolCalls[0]?.output).toMatchObject({ allowed: false })
    expect(res?.displays).toEqual([])
  })

  it('没有授权渠道时视为拒绝', async () => {
    const res = await lookAtScreen({})
    expect(screen.captured).toEqual([])
    expect(res?.toolCalls[0]?.output).toMatchObject({ allowed: false })
  })

  it('找不到可以查看的窗口时不请求授权', async () => {
    screen.target = null
    const requestPermission = vi.fn<(request: PermissionRequest) => Promise<boolean>>(async () => true)
    const res = await lookAtScreen({ requestPermission })

    expect(requestPermission).not.toHaveBeenCalled()
    expect(res?.toolCalls[0]?.error).toContain('没有找到可以查看的窗口')
  })

  it('由 LLM 决定看屏幕：意图识别 → 调用工具 → 授权 → 分析', async () => {
    const chatModel = scriptedModel(
      text('{"skills": ["screen"], "reason": "需要看用户的程序窗口"}'),
      call('look_at_screen', input),
      text('截图显示缺少 requests 模块'),
    )
    const visionModel = scriptedModel(text('缺少 requests 模块'))

    const res = await runAgent({
      model: chatModel,
      visionModel,
      messages: [user('你知道我现在这个程序为什么运行不了吗？')],
      skills: [screenSkill],
      requestPermission: async () => true,
    })

    expect(screen.captured).toEqual([42])
    expect(res?.skills.map((skill) => skill.id)).toEqual(['screen'])
    expect(res?.displays[0]?.title).toBe('屏幕分析')
    expect(res?.summary).toBe('截图显示缺少 requests 模块')
  })
})
