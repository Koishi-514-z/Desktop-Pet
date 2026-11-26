import type { AgentRunOptions } from '@/agent'
import { MockLanguageModelV3 } from 'ai/test'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type StreamPart = Awaited<ReturnType<MockLanguageModelV3['doStream']>>['stream'] extends ReadableStream<infer T> ? T : never

const mocks = vi.hoisted(() => ({
  model: null as unknown,
  runAgent: vi.fn<(options: AgentRunOptions) => Promise<null>>(),
}))

// 会话数据保存在内存里（不用 IndexedDB）
vi.mock('@/composables/storage', async () => {
  const { ref } = await import('vue')
  return { useIndexedDBStorage: <T>(_key: string, initial: T) => ({ data: ref(initial), ready: Promise.resolve() }) }
})
vi.mock('@/utils/llm', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/utils/llm')>(),
  resolveLanguageModel: () => mocks.model,
}))
vi.mock('@/agent', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/agent')>(),
  runAgent: mocks.runAgent,
}))

import { useChatStore } from '@/stores/chat'
import { useLanguageStore } from '@/stores/language'
import { buildReplyLanguagePrompt } from '@/utils/language'

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

/**
 * 流式回复的模型：每次调用依次输出 replies 中的一段段文字。
 * hang 为 true 的回复输出完文字后不结束，一直等到请求被取消（和真实的请求一样，取消时流以 AbortError 出错）
 */
function streamingModel(replies: { deltas: string[], hang?: boolean }[]) {
  return new MockLanguageModelV3({
    doStream: async ({ abortSignal }) => {
      const reply = replies.shift()
      if (!reply) throw new Error('没有更多预设的回复')
      const stream = new ReadableStream<StreamPart>({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] })
          controller.enqueue({ type: 'text-start', id: 'text' })
          for (const delta of reply.deltas) controller.enqueue({ type: 'text-delta', id: 'text', delta })
          if (reply.hang) {
            abortSignal?.addEventListener('abort', () => controller.error(new DOMException('请求被取消', 'AbortError')))
            return
          }
          controller.enqueue({ type: 'text-end', id: 'text' })
          controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage })
          controller.close()
        },
      })
      return { stream }
    },
  })
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  mocks.runAgent.mockReset()
  // 普通闲聊：Agent 判断不需要技能
  mocks.runAgent.mockResolvedValue(null)
  // store 中注册了 onMounted，在组件外创建时 Vue 会给出提示，这里不关心
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('打断对话', () => {
  it('生成回复时打断：已经说出的部分保留并标记为被打断，不算出错，也不再往语音管线送文字', async () => {
    mocks.model = streamingModel([{ deltas: ['从前有座山，', '山里有座庙。'], hang: true }])
    const chat = useChatStore()
    const chunks: string[] = []
    const onError = vi.fn(async () => {})
    const onFinish = vi.fn(async () => {})
    const onInterrupt = vi.fn(async () => {})
    chat.onChunk(async (delta) => { chunks.push(delta) })
    chat.onError(onError)
    chat.onFinish(onFinish)
    chat.onInterrupt(onInterrupt)

    const reply = chat.sendMessage('讲个故事')
    await vi.waitFor(() => expect(chunks.join('')).toBe('从前有座山，山里有座庙。'))
    expect(chat.isStreaming).toBe(true)

    chat.interrupt()
    // 界面立即恢复，语音管线收到通知
    expect(chat.isStreaming).toBe(false)
    expect(onInterrupt).toHaveBeenCalledTimes(1)

    await expect(reply).resolves.toBe('从前有座山，山里有座庙。')
    expect(chat.visibleMessages.at(-1)).toMatchObject({ role: 'assistant', content: '从前有座山，山里有座庙。', interrupted: true })
    expect(onError).not.toHaveBeenCalled()
    expect(onFinish).not.toHaveBeenCalled()
    expect(chunks.join('')).toBe('从前有座山，山里有座庙。')
  })

  it('执行工具时打断：取消 Agent 的请求，还没有内容的占位回复被移除', async () => {
    let agentSignal: AbortSignal | undefined
    mocks.runAgent.mockImplementation(({ abortSignal }) => new Promise((_, reject) => {
      agentSignal = abortSignal
      abortSignal?.addEventListener('abort', () => reject(abortSignal.reason))
    }))
    mocks.model = streamingModel([])
    const chat = useChatStore()
    const onError = vi.fn(async () => {})
    chat.onError(onError)

    const reply = chat.sendMessage('帮我查一下明天的天气')
    await vi.waitFor(() => expect(agentSignal).toBeDefined())
    chat.interrupt()

    expect(agentSignal!.aborted).toBe(true)
    await expect(reply).resolves.toBe('')
    expect(chat.visibleMessages.map((message) => message.role)).toEqual(['user'])
    expect(onError).not.toHaveBeenCalled()
  })

  it('只是语音还没播完时打断也会通知语音管线；排在后面的回复照常进行', async () => {
    mocks.model = streamingModel([{ deltas: ['第一句'], hang: true }, { deltas: ['第二个回答'] }])
    const chat = useChatStore()
    const onInterrupt = vi.fn(async () => {})
    chat.onInterrupt(onInterrupt)

    // 没有在生成回复
    chat.interrupt()
    expect(onInterrupt).toHaveBeenCalledTimes(1)

    const first = chat.sendMessage('第一个问题')
    const second = chat.sendMessage('第二个问题')
    await vi.waitFor(() => expect(chat.visibleMessages.at(-1)?.content).toBe('第一句'))
    chat.interrupt()

    await expect(first).resolves.toBe('第一句')
    await expect(second).resolves.toBe('第二个回答')
    expect(chat.visibleMessages.map((message) => [message.role, message.content, !!message.interrupted])).toEqual([
      ['user', '第一个问题', false],
      ['assistant', '第一句', true],
      ['user', '第二个问题', false],
      ['assistant', '第二个回答', false],
    ])
  })
})

describe('回复语言', () => {
  it('设置了显示语言时，回复的系统提示词末尾要求用这种语言回复；用户的消息原样发送', async () => {
    const model = streamingModel([{ deltas: ['こんにちは！'] }, { deltas: ['你好！'] }])
    mocks.model = model
    const chat = useChatStore()
    const language = useLanguageStore()
    const systemOf = (index: number) => model.doStreamCalls[index]!.prompt.find((message) => message.role === 'system')?.content ?? ''

    language.displayLanguage = 'ja'
    await expect(chat.sendMessage('你好')).resolves.toBe('こんにちは！')
    expect(systemOf(0).endsWith(buildReplyLanguagePrompt('ja'))).toBe(true)
    expect(model.doStreamCalls[0]!.prompt.at(-1)).toMatchObject({ role: 'user', content: [{ type: 'text', text: '你好' }] })

    // 改回不指定后马上生效
    language.displayLanguage = ''
    await chat.sendMessage('再说一次')
    expect(systemOf(1)).not.toContain('回复语言')
  })
})
