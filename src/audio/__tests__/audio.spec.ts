import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import { analyzeTranscript, listenToAudio, splitTranscript } from '@/audio/analyze'
import { clipWav, formatTimestamp, formatTranscript, planChunks, SAMPLE_RATE, transcribeSamples } from '@/audio/transcribe'
import { audioMarkers, findLatestAudioIds, formatDuration, isAudioFile, parseAudioIds } from '@/utils/audios'

/** seconds 秒的「声音」：quiet 中的时间段（秒）是静音，其余是正弦波 */
function speech(seconds: number, quiet: [number, number][] = []): Float32Array {
  return Float32Array.from({ length: seconds * SAMPLE_RATE }, (_, i) => {
    const t = i / SAMPLE_RATE
    return quiet.some(([from, to]) => t >= from && t < to) ? 0 : 0.3 * Math.sin(2 * Math.PI * 220 * t)
  })
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

function textModel(answer: (prompt: string) => string) {
  return new MockLanguageModelV3({
    doGenerate: async ({ prompt }) => {
      const text = prompt.map((message) => (typeof message.content === 'string' ? message.content : message.content.map((part) => ('text' in part ? part.text : '')).join(''))).join('\n')
      return { content: [{ type: 'text', text: answer(text) }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }
    },
  })
}

describe('切段与转录', () => {
  it('切成约一分钟的片段，在停顿处下刀；不足一段的放在最后', () => {
    // 52～53 秒、118～119 秒是停顿
    const chunks = planChunks(speech(150, [[52, 53], [118, 119]]), SAMPLE_RATE)
    expect(chunks).toHaveLength(3)
    const cuts = chunks.slice(1).map(([from]) => from / SAMPLE_RATE)
    // 从静音的中间切开，前后相接
    expect(cuts[0]).toBeCloseTo(52.5, 1)
    expect(cuts[1]).toBeCloseTo(118.5, 1)
    expect(chunks[0]![1]).toBe(chunks[1]![0])
    expect(chunks.at(-1)![1]).toBe(150 * SAMPLE_RATE)
    // 很短的录音不切
    expect(planChunks(speech(30), SAMPLE_RATE)).toEqual([[0, 30 * SAMPLE_RATE]])
  })

  it('并发转录各段，时间换算成相对整段开头；服务商给出分句时间时用它，否则一段算一句', async () => {
    const samples = speech(150, [[52, 53], [118, 119]])
    const progress: string[] = []
    let call = 0
    const result = await transcribeSamples(samples, {
      transcribe: vi.fn(async () => {
        const index = call++
        // 第二段带分句时间
        return index === 1
          ? { provider: 'Fish Audio', text: '第二段', segments: [{ text: '你好', start: 1, end: 2 }, { text: '再见', start: 10, end: 12 }] }
          : { provider: 'Fish Audio', text: index === 0 ? '第一段' : '', segments: [] }
      }),
      onProgress: (done, total) => progress.push(`${done}/${total}`),
    })
    expect(result.provider).toBe('Fish Audio')
    // 第二段从 52.5 秒开始：其中的分句时间加上这个偏移
    expect(result.segments.map((segment) => [Math.round(segment.start * 10) / 10, segment.text])).toEqual([[0, '第一段'], [53.5, '你好'], [62.5, '再见']])
    expect(progress).toEqual(['0/3', '1/3', '2/3', '3/3'])
    expect(formatTranscript(result.segments).split('\n')[1]).toBe('[00:00:53] 你好')
  })

  it('时间戳、时长与截取开头一段交给模型听', () => {
    expect(formatTimestamp(3723.9)).toBe('01:02:03')
    expect(formatDuration(65)).toBe('1:05')
    expect(formatDuration(3909)).toBe('1:05:09')
    const clip = clipWav(speech(10), 4)
    expect(clip).toMatchObject({ seconds: 4, truncated: true })
    expect(clip.wav.length).toBe(44 + 4 * SAMPLE_RATE * 2)
  })
})

describe('音频附件', () => {
  it('按类型或扩展名识别音频文件', () => {
    expect(isAudioFile({ name: 'a.mp3', type: 'audio/mpeg' })).toBe(true)
    expect(isAudioFile({ name: '会议.M4A', type: '' })).toBe(true)
    expect(isAudioFile({ name: 'a.png', type: 'image/png' })).toBe(false)
  })

  it('消息中的音频标记：带文件名与时长，能取回 id；找对话中最近发来的音频', () => {
    const marker = audioMarkers([{ id: 'aud_1', name: '会议.m4a', duration: 125, size: 1 }, { id: 'aud_2', name: '无时长.wav', duration: 0, size: 1 }])
    expect(marker).toBe('【附音频：aud_1｜会议.m4a｜2:05】\n【附音频：aud_2｜无时长.wav】')
    expect(parseAudioIds(marker)).toEqual(['aud_1', 'aud_2'])
    expect(findLatestAudioIds([
      { role: 'user', content: '【附音频：aud_old｜a.mp3】' },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: '总结一下\n\n【附音频：aud_new｜b.mp3｜1:00】' },
      { role: 'user', content: '再说说' },
    ])).toEqual(['aud_new'])
  })
})

describe('分析', () => {
  it('转录稿按行分段，每段不超过上限', () => {
    expect(splitTranscript('aaaa\nbbbb\ncccc', 9)).toEqual(['aaaa\nbbbb', 'cccc'])
  })

  it('不长的转录稿一次完成；很长时先分段提炼要点，再汇总', async () => {
    const short = textModel(() => '这是总结')
    expect(await analyzeTranscript({ model: short, transcript: '[00:00:01] 你好', task: 'summary' })).toBe('这是总结')
    expect(short.doGenerateCalls).toHaveLength(1)

    const long = textModel((prompt) => (prompt.includes('提炼这部分的要点') ? '要点' : '纪要'))
    const transcript = Array.from({ length: 3000 }, (_, i) => `[00:00:${String(i % 60).padStart(2, '0')}] 第 ${i} 句话，讨论项目进度`).join('\n')
    const statuses: string[] = []
    expect(await analyzeTranscript({ model: long, transcript, task: 'minutes', question: '重点写待办', onProgress: (status) => statuses.push(status) })).toBe('纪要')
    const parts = splitTranscript(transcript).length
    expect(parts).toBeGreaterThan(1)
    expect(long.doGenerateCalls).toHaveLength(parts + 1)
    expect(statuses.at(-1)).toBe('正在汇总…')
  })

  it('听声音：把 WAV 作为音频文件交给模型', async () => {
    const model = textModel(() => '是一段钢琴曲')
    const wav = clipWav(speech(1), 1).wav
    expect(await listenToAudio({ model, wav, question: '这是什么音乐' })).toBe('是一段钢琴曲')
    const user = model.doGenerateCalls[0]!.prompt.find((message) => message.role === 'user')!
    expect(user.content).toContainEqual(expect.objectContaining({ type: 'file', mediaType: 'audio/wav' }))
  })
})
