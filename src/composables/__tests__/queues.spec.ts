import { describe, expect, it } from 'vitest'
import { MIN_SENTENCE_LENGTH, sentenceLength, useTextProcessingQueue } from '@/composables/queues'

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
  it('句子的长度不算标点、符号与空白', () => {
    expect(sentenceLength('嗯。')).toBe(1)
    expect(sentenceLength('早上好呀～')).toBe(4)
    expect(sentenceLength('Hello, world!')).toBe(10)
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

  it('流式分段到达、中间夹着表情标记时，按原来的顺序输出', async () => {
    const park = long('今天我们去公园散步吧')
    const rain = long('不过下雨了就算了吧')
    expect(await process('<happy>嗯。', park.slice(0, 5), `${park.slice(5)}！<sad>${rain.slice(0, 2)}`, `${rain.slice(2)}。`)).toEqual([
      ['emotion', 'happy'],
      ['text', `嗯。${park}！`],
      ['emotion', 'sad'],
      ['text', `${rain}。`],
      ['end'],
    ])
  })

  it('重置后丢掉还在等着合并的短句', async () => {
    const { queue, events } = setup()
    queue.enQueue('<happy>嗯。<sad>')
    await settle()
    queue.resetQueue()
    queue.enQueue('今天我们去公园散步吧！')
    queue.endQueue()
    await settle()
    expect(texts(events)).toEqual(['今天我们去公园散步吧！'])
  })
})
