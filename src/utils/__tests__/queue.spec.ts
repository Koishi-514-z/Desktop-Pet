import { describe, expect, it } from 'vitest'
import { createParallelSequencedQueue } from '@/utils/queue'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// 等队列内部排队的微任务全部执行完
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

// 每个输入对应一个手动控制何时完成的处理任务（模拟语音合成），输出按到达顺序记录
function setup() {
  const tasks = new Map<string, ReturnType<typeof deferred<string>>>()
  const outputs: string[] = []
  const queue = createParallelSequencedQueue<string, string>({
    processor: ({ data }) => {
      const task = deferred<string>()
      tasks.set(data, task)
      return task.promise
    },
    outputHandler: async ({ data }) => {
      outputs.push(data)
    },
  })
  const task = (name: string) => tasks.get(name)!
  return { queue, task, outputs }
}

describe('createParallelSequencedQueue', () => {
  it('并行处理，按入队顺序输出', async () => {
    const { queue, task, outputs } = setup()
    queue.enqueue('a')
    queue.enqueue('b')
    queue.enqueue('c')

    task('c').resolve('C')
    task('b').resolve('B')
    await flush()
    expect(outputs).toEqual([])

    task('a').resolve('A')
    await flush()
    expect(outputs).toEqual(['A', 'B', 'C'])
  })

  it('reset 之后才完成的旧任务被丢弃，不占用新一轮的序号', async () => {
    const { queue, task, outputs } = setup()
    queue.enqueue('old-0')
    queue.enqueue('old-1')
    task('old-0').resolve('OLD-0')
    await flush()

    queue.reset()
    queue.enqueue('new-0')
    queue.enqueue('new-1')
    // 旧一轮的第 1 项与新一轮的第 1 项序号相同
    task('old-1').resolve('OLD-1')
    task('new-0').resolve('NEW-0')
    await flush()
    task('new-1').resolve('NEW-1')
    await flush()

    expect(outputs).toEqual(['OLD-0', 'NEW-0', 'NEW-1'])
  })

  it('reset 之后才失败的旧任务不会让新一轮跳过内容', async () => {
    const { queue, task, outputs } = setup()
    queue.enqueue('old-0')

    queue.reset()
    queue.enqueue('new-0')
    task('old-0').reject(new Error('合成失败'))
    await flush()
    task('new-0').resolve('NEW-0')
    await flush()

    expect(outputs).toEqual(['NEW-0'])
  })

  it('reset 之后新一轮的失败项照常跳过', async () => {
    const { queue, task, outputs } = setup()
    queue.enqueue('old-0')
    queue.reset()
    queue.enqueue('new-0')
    queue.enqueue('new-1')

    task('new-0').reject(new Error('合成失败'))
    task('new-1').resolve('NEW-1')
    await flush()

    expect(outputs).toEqual(['NEW-1'])
  })
})
