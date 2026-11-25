import { describe, expect, it } from 'vitest'
import { sentenceLength, useTextProcessingQueue } from '@/composables/queues'

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

describe('文本处理队列', () => {
  it('句子的长度不算标点、符号与空白', () => {
    expect(sentenceLength('嗯。')).toBe(1)
    expect(sentenceLength('早上好呀～')).toBe(4)
    expect(sentenceLength('Hello, world!')).toBe(10)
  })

  it('够长的句子遇到句末标点就输出', async () => {
    expect(texts(await process('今天天气很好，我们去公园散步吧。下午还可以一起去看电影！'))).toEqual([
      '今天天气很好，我们去公园散步吧。',
      '下午还可以一起去看电影！',
    ])
  })

  it('太短的句子不单独输出，与下一句合并', async () => {
    expect(texts(await process('嗯。好的！今天我们去公园散步吧。'))).toEqual(['嗯。好的！今天我们去公园散步吧。'])
    expect(texts(await process('OK! That sounds like a great plan.'))).toEqual(['OK! That sounds like a great plan.'])
  })

  it('结束时剩下的短句也输出', async () => {
    expect(texts(await process('今天我们去公园散步吧。好呀。'))).toEqual(['今天我们去公园散步吧。', '好呀。'])
  })

  it('连续的句末标点算一处，紧跟的右引号归到这一句', async () => {
    expect(texts(await process('今天真的是好累好累啊……明天还要早起去上班。'))).toEqual(['今天真的是好累好累啊……', '明天还要早起去上班。'])
    expect(texts(await process('真的吗？！我还以为你忘记了呢……'))).toEqual(['真的吗？！我还以为你忘记了呢……'])
    expect(texts(await process('他回答说：“没问题，交给我来处理吧。”然后就走了出去。'))).toEqual([
      '他回答说：“没问题，交给我来处理吧。”',
      '然后就走了出去。',
    ])
  })

  it('流式分段到达、中间夹着表情标记时，按原来的顺序输出', async () => {
    expect(await process('<happy>嗯。', '今天我们去公', '园散步吧！<sad>不过', '下雨了就算了吧。')).toEqual([
      ['emotion', 'happy'],
      ['text', '嗯。今天我们去公园散步吧！'],
      ['emotion', 'sad'],
      ['text', '不过下雨了就算了吧。'],
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
