import type { ToolExecutionOptions } from 'ai'
import type { StoredAudio } from '@/utils/audios'
import { MockLanguageModelV3 } from 'ai/test'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// IndexedDB、音频解码、语音识别与模型设置都换成模拟的
const mocks = vi.hoisted(() => ({
  audios: new Map<string, StoredAudio>(),
  transcribeClip: vi.fn(),
  audioModel: undefined as unknown,
}))

vi.mock('@/utils/audios', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/utils/audios')>(),
  loadAudio: vi.fn(async (id: string) => mocks.audios.get(id)),
  saveTranscript: vi.fn(async (id: string, transcript: StoredAudio['transcript']) => {
    const audio = mocks.audios.get(id)
    if (audio) mocks.audios.set(id, { ...audio, transcript })
  }),
}))
vi.mock('@/audio/transcribe', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/audio/transcribe')>(),
  // 10 秒的「录音」
  decodeAudio: vi.fn(async () => new Float32Array(10 * 16000).fill(0.1)),
}))
vi.mock('@/stores/transcription', () => ({ useTranscriptionStore: () => ({ transcribeClip: mocks.transcribeClip }) }))
vi.mock('@/stores/agent', () => ({ useAgentStore: () => ({ resolveAudioModel: () => mocks.audioModel }) }))

import { audioSkill } from '@/agent/skills/audio'

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

function textModel(text: string, fail = false) {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      if (fail) throw new Error('model does not support audio input')
      return { content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }
    },
  })
}

function run(name: keyof typeof audioSkill.tools, input: unknown, messages: unknown[] = [], model = textModel('总结结果')) {
  const options = {
    toolCallId: 'call',
    messages,
    experimental_context: { model, visionModel: model, setStatus: vi.fn() },
  } as unknown as ToolExecutionOptions
  return audioSkill.tools[name]!.execute!(input as never, options) as Promise<Record<string, unknown>>
}

const withAudio = [{ role: 'user', content: '帮我看看\n\n【附音频：aud_1｜会议.m4a｜0:10】' }]

beforeEach(() => {
  mocks.audios.clear()
  mocks.audios.set('aud_1', { id: 'aud_1', name: '会议.m4a', mediaType: 'audio/mp4', size: 1, duration: 10, data: new Blob(), createdAt: 0 })
  mocks.transcribeClip.mockReset()
  mocks.transcribeClip.mockResolvedValue({ provider: 'Fish Audio', text: '今天讨论上线时间，定在下周五。', segments: [] })
  mocks.audioModel = undefined
})

describe('音频理解', () => {
  it('转录对话中最近发来的音频，结果以卡片展示并保存，再次使用时不重新转录', async () => {
    const result = await run('transcribe_audio', {}, withAudio)
    expect(result).toMatchObject({ audioId: 'aud_1', name: '会议.m4a', duration: '0:10', transcribed: true })
    expect((result.display as { content: string }).content).toBe('[00:00:00] 今天讨论上线时间，定在下周五。')
    expect(mocks.audios.get('aud_1')!.transcript).toEqual({ provider: 'Fish Audio', segments: [{ start: 0, end: 10, text: '今天讨论上线时间，定在下周五。' }] })

    await run('analyze_speech', { task: 'minutes' }, withAudio)
    expect(mocks.transcribeClip).toHaveBeenCalledTimes(1)
  })

  it('总结、会议纪要、回答问题：根据转录稿由模型完成', async () => {
    const model = textModel('会议决定下周五上线')
    const result = await run('analyze_speech', { task: 'minutes', question: '列出待办' }, withAudio, model)
    expect(result.display).toEqual({ title: '会议纪要：会议.m4a', content: '会议决定下周五上线', format: 'text' })
    const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt)
    expect(prompt).toContain('今天讨论上线时间')
    expect(prompt).toContain('列出待办')
  })

  it('没有识别出说话的内容时，提示改为听声音', async () => {
    mocks.transcribeClip.mockResolvedValue({ provider: 'Fish Audio', text: '', segments: [] })
    expect(await run('analyze_speech', { task: 'summary' }, withAudio)).toMatchObject({ done: false, message: expect.stringContaining('listen_to_audio') })
  })

  it('听声音：优先用单独设置的模型；模型不能接收音频时提示去设置中选择', async () => {
    mocks.audioModel = textModel('背景里有雨声')
    expect(await run('listen_to_audio', { question: '背景里有什么声音' }, withAudio)).toMatchObject({
      listenedSeconds: 10,
      truncated: false,
      display: { title: '声音分析：会议.m4a', content: '背景里有雨声' },
    })

    mocks.audioModel = textModel('', true)
    await expect(run('listen_to_audio', { question: '这是什么' }, withAudio)).rejects.toThrow('设置 → Skills')
  })

  it('对话中没有音频时说明需要先发送；可以指定更早的音频 id', async () => {
    await expect(run('transcribe_audio', {}, [{ role: 'user', content: '你好' }])).rejects.toThrow('对话中还没有音频')
    await expect(run('transcribe_audio', { audioId: 'aud_missing' })).rejects.toThrow('找不到音频')
  })

  it('音频太长时不解码，说明最长支持多久', async () => {
    mocks.audios.set('aud_1', { ...mocks.audios.get('aud_1')!, duration: 3 * 3600 })
    await expect(run('transcribe_audio', {}, withAudio)).rejects.toThrow('音频太长')
  })
})
