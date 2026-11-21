import { ref } from "vue"

export interface HandlerContext<T> {
  data: T
  emit: (eventName: string, ...params: any[]) => void
}

export interface Events<T> {
  enqueue: Array<(payload: T, queueLength: number) => void>
  dequeue: Array<(payload: T, queueLength: number) => void>
  process: Array<(payload: T, handler: (param: HandlerContext<T>) => Promise<any>) => void>
  error: Array<(payload: T, error: unknown, handler: (param: HandlerContext<T>) => Promise<any>) => void>
  result: Array<<R>(payload: T, result: R, handler: (param: HandlerContext<T>) => Promise<any>) => void>
  drain: Array<() => void>
}

// 单线程消费队列
export function createQueue<T>(options: {
  handlers: Array<(ctx: HandlerContext<T>) => Promise<void>>
}) {
  const queue: T[] = []
  const finalHandlers = ref<((ctx: HandlerContext<T>) => Promise<void>)[]>(options.handlers)
  let drainTask: Promise<any> | undefined

  const internalEventListeners: Events<T> = {
    enqueue: [],
    dequeue: [],
    process: [],
    error: [],
    result: [],
    drain: [],
  }
  const internalHandlerEventListeners: Record<string, Array<(...params: any[]) => void>> = {}

  function on<E extends keyof Events<T>>(eventName: E, listener: Events<T>[E][number]) {
    internalEventListeners[eventName].push(listener as any)
  }

  function emit<E extends keyof Events<T>>(eventName: E, ...params: Parameters<Events<T>[E][number]>) {
    const listeners = internalEventListeners[eventName] as Events<T>[E]
    listeners.forEach(listener => (listener as any)(...params))
  }

  function onHandlerEvent(eventName: string, listener: (...params: any[]) => void) {
    internalHandlerEventListeners[eventName] = internalHandlerEventListeners[eventName] || []
    internalHandlerEventListeners[eventName].push(listener)
  }

  function emitHandlerEvent(eventName: string, ...params: any[]) {
    const listeners = internalHandlerEventListeners[eventName] || []
    listeners.forEach(listener => listener(...params))
  }

  function enqueue(payload: T) {
    queue.push(payload)
    emit('enqueue', payload, queue.length)
    scheduleDrain()
  }

  function clear() {
    queue.length = 0
  }

  function addHandler(handler: (ctx: HandlerContext<T>) => Promise<void>) {
    finalHandlers.value.push(handler)
  }

  function scheduleDrain() {
    if (drainTask || queue.length === 0) return
    drainTask = Promise.resolve().then(drain).finally(() => {
      drainTask = undefined
      scheduleDrain()
    })
  }

  async function drain() {
    while (queue.length > 0) {
      const payload = queue.shift() as T
      emit('dequeue', payload, queue.length)
      for (const handler of finalHandlers.value) {
        emit('process', payload, handler)
        try {
          const result = await handler({ data: payload, emit: emitHandlerEvent })
          emit('result', payload, result, handler)
        }
        catch (err) {
          emit('error', payload, err, handler)
          continue
        }
      }
    }
    emit('drain')
  }

  function length() {
    return queue.length
  }

  return {
    enqueue,
    addHandler,
    clear,
    length,
    on,
    onHandlerEvent,
  }
}


/**
 * 并行消费队列
 * 支持多个任务同时执行，可配置最大并发数
 */
export function createParallelQueue<T>(options: {
  handlers: Array<(ctx: HandlerContext<T>) => Promise<void>>
  concurrency?: number
}) {
  const queue: T[] = []
  const finalHandlers = ref<((ctx: HandlerContext<T>) => Promise<void>)[]>(options.handlers)
  const concurrency = options.concurrency ?? Infinity

  /** 当前正在执行的任务数 */
  let activeCount = 0

  /** 是否正在消费 */
  let isProcessing = false

  const internalEventListeners: Events<T> = {
    enqueue: [],
    dequeue: [],
    process: [],
    error: [],
    result: [],
    drain: [],
  }
  const internalHandlerEventListeners: Record<string, Array<(...params: any[]) => void>> = {}

  function on<E extends keyof Events<T>>(eventName: E, listener: Events<T>[E][number]) {
    internalEventListeners[eventName].push(listener as any)
  }

  function emit<E extends keyof Events<T>>(eventName: E, ...params: Parameters<Events<T>[E][number]>) {
    const listeners = internalEventListeners[eventName] as Events<T>[E]
    listeners.forEach(listener => (listener as any)(...params))
  }

  function onHandlerEvent(eventName: string, listener: (...params: any[]) => void) {
    internalHandlerEventListeners[eventName] = internalHandlerEventListeners[eventName] || []
    internalHandlerEventListeners[eventName].push(listener)
  }

  function emitHandlerEvent(eventName: string, ...params: any[]) {
    const listeners = internalHandlerEventListeners[eventName] || []
    listeners.forEach(listener => listener(...params))
  }

  function enqueue(payload: T) {
    queue.push(payload)
    emit('enqueue', payload, queue.length)
    processNext()
  }

  function clear() {
    queue.length = 0
  }

  function addHandler(handler: (ctx: HandlerContext<T>) => Promise<void>) {
    finalHandlers.value.push(handler)
  }

  async function processItem(payload: T) {
    activeCount++
    emit('dequeue', payload, queue.length)

    for (const handler of finalHandlers.value) {
      emit('process', payload, handler)
      try {
        const result = await handler({ data: payload, emit: emitHandlerEvent })
        emit('result', payload, result, handler)
      }
      catch (err) {
        emit('error', payload, err, handler)
        continue
      }
    }

    activeCount--
    processNext()
  }

  function processNext() {
    if (isProcessing) return
    isProcessing = true

    while (queue.length > 0 && activeCount < concurrency) {
      const payload = queue.shift() as T
      processItem(payload)
    }

    isProcessing = false

    if (queue.length === 0 && activeCount === 0) {
      emit('drain')
    }
  }

  function length() {
    return queue.length
  }

  function active() {
    return activeCount
  }

  return {
    enqueue,
    addHandler,
    clear,
    length,
    active,
    on,
    onHandlerEvent,
  }
}

export interface SequencedItem<T> {
  sequence: number
  data: T
}

export interface SequencedEvents<T> {
  enqueue: Array<(payload: SequencedItem<T>, queueLength: number) => void>
  dequeue: Array<(payload: SequencedItem<T>, queueLength: number) => void>
  process: Array<(payload: SequencedItem<T>, handler: (param: HandlerContext<T> & { sequence: number }) => Promise<any>) => void>
  error: Array<(payload: SequencedItem<T>, error: unknown, handler: (param: HandlerContext<T> & { sequence: number }) => Promise<any>) => void>
  result: Array<<R>(payload: SequencedItem<T>, result: R, handler: (param: HandlerContext<T> & { sequence: number }) => Promise<any>) => void>
  drain: Array<() => void>
  skip: Array<(skippedSequence: number) => void>
}

/**
 * 序号消费队列
 * 保证按序号顺序消费，即使乱序入队也会等待前序完成
 */
export function createSequencedQueue<T>(options: {
  handlers: Array<(ctx: HandlerContext<T> & { sequence: number }) => Promise<void>>
  startSequence?: number
}) {
  const finalHandlers = ref<((ctx: HandlerContext<T> & { sequence: number }) => Promise<void>)[]>(options.handlers)
  /** 等待处理的项目（按序号存储） */
  const pendingItems = new Map<number, T>()
  /** 下一个应处理的序号 */
  let nextSequence = options.startSequence ?? 0

  /** 已跳过的序号 */
  const skippedSequences = new Set<number>()

  /** 当前是否正在消费 */
  let drainTask: Promise<void> | undefined

  const internalEventListeners: SequencedEvents<T> = {
    enqueue: [],
    dequeue: [],
    process: [],
    error: [],
    result: [],
    drain: [],
    skip: [],
  }
  const internalHandlerEventListeners: Record<string, Array<(...params: any[]) => void>> = {}

  function on<E extends keyof SequencedEvents<T>>(eventName: E, listener: SequencedEvents<T>[E][number]) {
    internalEventListeners[eventName].push(listener as any)
  }

  function emit<E extends keyof SequencedEvents<T>>(eventName: E, ...params: Parameters<SequencedEvents<T>[E][number]>) {
    const listeners = internalEventListeners[eventName] as SequencedEvents<T>[E]
    listeners.forEach(listener => (listener as any)(...params))
  }

  function onHandlerEvent(eventName: string, listener: (...params: any[]) => void) {
    internalHandlerEventListeners[eventName] = internalHandlerEventListeners[eventName] || []
    internalHandlerEventListeners[eventName].push(listener)
  }

  function emitHandlerEvent(eventName: string, ...params: any[]) {
    const listeners = internalHandlerEventListeners[eventName] || []
    listeners.forEach(listener => listener(...params))
  }

  function addHandler(handler: (ctx: HandlerContext<T> & { sequence: number }) => Promise<void>) {
    finalHandlers.value.push(handler)
  }

  function scheduleDrain() {
    if (drainTask || (!pendingItems.has(nextSequence) && !skippedSequences.has(nextSequence))) return
    drainTask = Promise.resolve().then(drain).finally(() => {
      drainTask = undefined
      scheduleDrain()
    })
  }

  function enqueue(sequence: number, payload: T) {
    pendingItems.set(sequence, payload)
    emit('enqueue', { sequence, data: payload }, pendingItems.size)
    scheduleDrain()
  }

  function skip(sequence: number) {
    if (sequence === nextSequence) {
      nextSequence++
      scheduleDrain()
    }
    else if (sequence > nextSequence) {
      pendingItems.delete(sequence)
      skippedSequences.add(sequence)
    }
    emit('skip', sequence)
  }

  function clear() {
    pendingItems.clear()
    skippedSequences.clear()
  }

  function reset(startSequence?: number) {
    pendingItems.clear()
    skippedSequences.clear()
    nextSequence = startSequence ?? 0
    drainTask = undefined
  }

  async function drain() {
    while (pendingItems.has(nextSequence) || skippedSequences.has(nextSequence)) {
      if (skippedSequences.has(nextSequence)) {
        skippedSequences.delete(nextSequence)
        nextSequence++
        continue
      }

      const payload = pendingItems.get(nextSequence) as T
      const currentSequence = nextSequence
      pendingItems.delete(currentSequence)
      nextSequence++

      const sequencedPayload: SequencedItem<T> = { sequence: currentSequence, data: payload }
      emit('dequeue', sequencedPayload, pendingItems.size)

      for (const handler of finalHandlers.value) {
        
        emit('process', sequencedPayload, handler)
        try {
          const result = await handler({ data: payload, emit: emitHandlerEvent, sequence: currentSequence })
          emit('result', sequencedPayload, result, handler)
        }
        catch (err) {
          emit('error', sequencedPayload, err, handler)
          continue
        }
      }
    }

    if (pendingItems.size === 0) {
      emit('drain')
    }
  }

  function length() {
    return pendingItems.size
  }

  function getNextSequence() {
    return nextSequence
  }

  function hasPending(sequence: number) {
    return pendingItems.has(sequence)
  }

  return {
    enqueue,
    addHandler,
    skip,
    clear,
    reset,
    length,
    getNextSequence,
    hasPending,
    on,
    onHandlerEvent,
  }
}


/**
 * 并行处理但顺序输出的队列
 * 结合了并行队列和序号队列的特点：
 * - 处理阶段并行执行
 * - 输出阶段按入队顺序执行
 */
export function createParallelSequencedQueue<T, R>(options: {
  processor?: (ctx: HandlerContext<T>) => Promise<R>
  outputHandler?: (ctx: HandlerContext<R> & { sequence: number, originalData: T }) => Promise<void>
  concurrency?: number
}) {
  let sequenceCounter = 0

  const finalProcessor = ref<((ctx: HandlerContext<T>) => Promise<R>) | null>(options.processor ?? null)
  const finalOutputHandler = ref<((ctx: HandlerContext<R> & { sequence: number, originalData: T }) => Promise<void>) | null>(options.outputHandler ?? null)

  interface CombinedEvents {
    enqueue: Array<(payload: T, sequence: number) => void>
    processStart: Array<(payload: T, sequence: number) => void>
    processComplete: Array<(payload: T, result: R, sequence: number) => void>
    processError: Array<(payload: T, error: unknown, sequence: number) => void>
    outputStart: Array<(result: R, sequence: number) => void>
    outputComplete: Array<(result: R, sequence: number) => void>
    outputError: Array<(result: R, error: unknown, sequence: number) => void>
  }

  const internalEventListeners: CombinedEvents = {
    enqueue: [],
    processStart: [],
    processComplete: [],
    processError: [],
    outputStart: [],
    outputComplete: [],
    outputError: [],
  }
  const internalHandlerEventListeners: Record<string, Array<(...params: any[]) => void>> = {}

  function on<E extends keyof CombinedEvents>(eventName: E, listener: CombinedEvents[E][number]) {
    internalEventListeners[eventName].push(listener as any)
  }

  function emit<E extends keyof CombinedEvents>(eventName: E, ...params: Parameters<CombinedEvents[E][number]>) {
    const listeners = internalEventListeners[eventName] as CombinedEvents[E]
    listeners.forEach(listener => (listener as any)(...params))
  }

  function onHandlerEvent(eventName: string, listener: (...params: any[]) => void) {
    internalHandlerEventListeners[eventName] = internalHandlerEventListeners[eventName] || []
    internalHandlerEventListeners[eventName].push(listener)
  }

  function emitHandlerEvent(eventName: string, ...params: any[]) {
    const listeners = internalHandlerEventListeners[eventName] || []
    listeners.forEach(listener => listener(...params))
  }

  // 输出阶段：使用 SequencedQueue 保证按序消费
  const outputQueue = createSequencedQueue<{ result: R, originalData: T }>({
    handlers: [
      async (ctx) => {
        const { result, originalData } = ctx.data
        const sequence = ctx.sequence
        emit('outputStart', result, sequence)
        try {
          if (finalOutputHandler.value) {
            await finalOutputHandler.value({ data: result, sequence, originalData, emit: emitHandlerEvent })
          }
          emit('outputComplete', result, sequence)
        }
        catch (err) {
          emit('outputError', result, err, sequence)
        }
      }
    ],
  })

  // 处理阶段：使用 ParallelQueue 并行执行
  const processQueue = createParallelQueue<{ sequence: number, data: T }>({
    handlers: [
      async (ctx) => {
        const { sequence, data } = ctx.data
        if (!finalProcessor.value) {
          emit('processError', data, new Error('Processor not set'), sequence)
          outputQueue.skip(sequence)
          return
        }
        emit('processStart', data, sequence)
        try {
          const result = await finalProcessor.value({ data, emit: emitHandlerEvent })
          if (result) {
            emit('processComplete', data, result, sequence)
          }
          outputQueue.enqueue(sequence, { result, originalData: data })
        }
        catch (err) {
          emit('processError', data, err, sequence)
          outputQueue.skip(sequence)
        }
      }
    ],
    concurrency: options.concurrency,
  })


  function enqueue(payload: T) {
    const sequence = sequenceCounter++
    emit('enqueue', payload, sequence)
    processQueue.enqueue({ sequence, data: payload })
  }

  function reset() {
    outputQueue.reset()
    processQueue.clear()
    sequenceCounter = 0
  }

  function inputLength() {
    return processQueue.length()
  }

  function pendingLength() {
    return outputQueue.length()
  }

  function setProcessor(processor: (ctx: HandlerContext<T>) => Promise<R>) {
    finalProcessor.value = processor
  }

  function setOutputHandler(outputHandler: (ctx: HandlerContext<R> & { sequence: number, originalData: T }) => Promise<void>) {
    finalOutputHandler.value = outputHandler
  }

  return {
    enqueue,
    reset,
    inputLength,
    pendingLength,
    setProcessor,
    setOutputHandler,
    on,
    onHandlerEvent,
  }
}


export type UseQueueReturn<T> = ReturnType<typeof createQueue<T>>
export type UseParallelQueueReturn<T> = ReturnType<typeof createParallelQueue<T>>
export type UseSequencedQueueReturn<T> = ReturnType<typeof createSequencedQueue<T>>
export type UseParallelSequencedQueueReturn<T, R> = ReturnType<typeof createParallelSequencedQueue<T, R>>
