import type { Utterance } from '@/composables/queues'
import { describe, expect, it } from 'vitest'
import { MIN_SENTENCE_LENGTH, sentenceLength, useTextProcessingQueue, useTranscriptionQueue, useVoiceDetectingQueue } from '@/composables/queues'
import { VOICE_FRAME_SAMPLES, VOICE_SAMPLE_RATE } from '@/utils/voice-activity'

type QueueEvent = ['text', string] | ['emotion', string] | ['end']

function setup() {
  const queue = useTextProcessingQueue()
  const events: QueueEvent[] = []
  queue.onTextProcessed((text) => events.push(['text', text]))
  queue.onEmotionProcessed((emotion) => events.push(['emotion', emotion]))
  queue.onEndProcessed(() => events.push(['end']))
  return { queue, events }
}

// 队列异步处理，等它处理完已经放进去的内容
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

async function process(...chunks: string[]) {
  const { queue, events } = setup()
  chunks.forEach((chunk) => queue.enQueue(chunk))
  queue.endQueue()
  await settle()
  return events
}

const texts = (events: QueueEvent[]) => events.filter((event) => event[0] === 'text').map((event) => event[1])

// 刚好够长的句子（不含句末标点）：不管 MIN_SENTENCE_LENGTH 调成多少都成立
const long = (head: string, filler = '啊') => head + filler.repeat(Math.max(0, MIN_SENTENCE_LENGTH - sentenceLength(head)))

describe('文本处理队列', () => {
  it('句子的长度不算情绪标签、标点、符号与空白', () => {
    expect(sentenceLength('嗯。')).toBe(1)
    expect(sentenceLength('早上好呀～')).toBe(4)
    expect(sentenceLength('Hello, world!')).toBe(10)
    expect(sentenceLength('[happy]嗯。[short pause]')).toBe(1)
  })

  it('够长的句子遇到句末标点就输出', async () => {
    const first = `${long('今天天气很好，我们去公园散步吧')}。`
    const second = `${long('下午还可以一起去看电影')}！`
    expect(texts(await process(first + second))).toEqual([first, second])
  })

  it('太短的句子不单独输出，与下一句合并', async () => {
    const sentence = `${long('今天我们去公园散步吧')}。`
    expect(texts(await process(`嗯。好的！${sentence}`))).toEqual([`嗯。好的！${sentence}`])
    const english = `OK! ${long('That sounds like a great plan', 'a')}.`
    expect(texts(await process(english))).toEqual([english])
  })

  it('结束时剩下的短句也输出', async () => {
    const sentence = `${long('今天我们去公园散步吧')}。`
    expect(texts(await process(`${sentence}好呀。`))).toEqual([sentence, '好呀。'])
  })

  it('连续的句末标点算一处，紧跟的右引号归到这一句', async () => {
    const tired = `${long('今天真的是好累好累啊')}……`
    const work = `${long('明天还要早起去上班')}。`
    expect(texts(await process(tired + work))).toEqual([tired, work])
    const surprised = `真的吗？！${long('我还以为你忘记了呢')}……`
    expect(texts(await process(surprised))).toEqual([surprised])
    const quoted = `他回答说：“${long('没问题，交给我来处理吧')}。”`
    expect(texts(await process(`${quoted}然后就走了出去。`))).toEqual([quoted, '然后就走了出去。'])
  })

  it('流式分段到达、中间夹着情绪标签时，按原来的顺序输出；标签留在语句中交给语音合成', async () => {
    const park = long('今天我们去公园散步吧')
    const rain = long('不过下雨了就算了吧')
    expect(await process('[happy]嗯。', park.slice(0, 5), `${park.slice(5)}！[sad]${rain.slice(0, 2)}`, `${rain.slice(2)}。`)).toEqual([
      ['emotion', 'happy'],
      ['text', `[happy]嗯。${park}！`],
      ['emotion', 'sad'],
      ['text', `[sad]${rain}。`],
      ['end'],
    ])
  })

  it('跨分段到达的标签也能识别，标签名统一为小写、单词之间一个空格', async () => {
    const think = long('我想想')
    expect(await process(`${think}[Sh`, 'ort  pa', `use ]还是算了吧。`)).toEqual([
      ['emotion', 'short pause'],
      ['text', `${think}[short pause]还是算了吧。`],
      ['end'],
    ])
  })

  it('方括号里不是英文单词的内容不算标签；模型输出的文字不会被当作结束', async () => {
    expect(await process('见第[1]条。<END/>好的。')).toEqual([
      ['text', '见第[1]条。<END/>好的。'],
      ['end'],
    ])
  })

  it('重置后丢掉还在等着合并的短句', async () => {
    const { queue, events } = setup()
    queue.enQueue('[happy]嗯。[sad]')
    await settle()
    queue.resetQueue()
    queue.enQueue('今天我们去公园散步吧！')
    queue.endQueue()
    await settle()
    expect(texts(events)).toEqual(['今天我们去公园散步吧！'])
  })
})

/** 若干毫秒的声音：振幅为 0 时是安静，否则是正弦波（模拟说话） */
function sound(ms: number, amplitude: number): Float32Array[] {
  const count = ms / (VOICE_FRAME_SAMPLES / VOICE_SAMPLE_RATE * 1000)
  return Array.from({ length: count }, (_, i) => Float32Array.from(
    { length: VOICE_FRAME_SAMPLES },
    (__, n) => amplitude * Math.sin(2 * Math.PI * 220 * (i * VOICE_FRAME_SAMPLES + n) / VOICE_SAMPLE_RATE),
  ))
}

describe('语音检测队列', () => {
  function detect(...parts: Float32Array[][]) {
    const queue = useVoiceDetectingQueue()
    const events: string[] = []
    const utterances: Utterance[] = []
    queue.onSpeechStarted(() => events.push('start'))
    queue.onUtteranceDetected((utterance) => {
      events.push('utterance')
      utterances.push(utterance)
    })
    queue.onSpeechEnded(() => events.push('end'))
    parts.flat().forEach((frame) => queue.enQueue(frame))
    return { events, utterances }
  }

  it('说完一句话时依次给出开始、这句话（WAV）与结束', async () => {
    const { events, utterances } = detect(sound(1000, 0), sound(1000, 0.2), sound(1200, 0))
    await settle()
    expect(events).toEqual(['start', 'utterance', 'end'])
    expect(String.fromCharCode(...utterances[0]!.audio.subarray(0, 4))).toBe('RIFF')
    expect(utterances[0]!.durationMs).toBeGreaterThan(1400)
  })

  it('太短的声音只有开始与结束，没有这句话', async () => {
    const { events } = detect(sound(1000, 0), sound(100, 0.3), sound(1200, 0))
    await settle()
    expect(events).toEqual(['start', 'end'])
  })
})

describe('语音识别队列', () => {
  const utterance = (id: number): Utterance => ({ audio: Uint8Array.of(id), durationMs: 1000 })

  it('并行识别，按说话的顺序输出；识别失败的句子被跳过', async () => {
    const queue = useTranscriptionQueue()
    const outputs: string[] = []
    // 第一句识别得最慢，第三句识别失败
    const delays = [60, 10, 20, 5]
    queue.onItemReceived(async ({ data }) => {
      const id = data.audio[0]!
      await new Promise((resolve) => setTimeout(resolve, delays[id]))
      if (id === 2) throw new Error('识别失败')
      return `第${id}句`
    })
    queue.onItemTranscribed(async ({ data }) => {
      outputs.push(data)
    })
    for (const id of [0, 1, 2, 3]) queue.enQueue(utterance(id))
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(outputs).toEqual(['第0句', '第1句', '第3句'])
  })
})
