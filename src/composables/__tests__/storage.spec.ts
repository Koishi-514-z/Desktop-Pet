import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface Session {
  id: string
  title: string
}

const KEY = 'chat/sessions'

// 每个用例使用全新的数据库，并重新加载模块（db.ts 会缓存打开的数据库）
async function load() {
  vi.resetModules()
  const { useIndexedDBStorage } = await import('@/composables/storage')
  const db = await import('@/utils/db')
  return { useIndexedDBStorage, db }
}

// 隐藏窗口时会立即写入还没保存的改动
function flushPending() {
  window.dispatchEvent(new Event('pagehide'))
}

describe('useIndexedDBStorage', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('把 localStorage 中的旧数据迁移过来，之后的改动以 JSON 字符串整体保存', async () => {
    localStorage.setItem(KEY, JSON.stringify([{ id: 'a', title: '旧会话' }]))
    const { useIndexedDBStorage, db } = await load()

    const { data, ready } = useIndexedDBStorage<Session[]>(KEY, [])
    expect(data.value).toEqual([])
    await ready
    expect(data.value).toEqual([{ id: 'a', title: '旧会话' }])
    expect(localStorage.getItem(KEY)).toBeNull()

    data.value[0]!.title = '改过的标题'
    await Promise.resolve()
    flushPending()
    await vi.waitFor(async () => {
      expect(await db.getJson(KEY)).toEqual([{ id: 'a', title: '改过的标题' }])
    })
    // 保存的是 JSON 字符串
    const raw = await db.withStore(db.KV_STORE, 'readonly', (store) => store.get(KEY))
    expect(typeof raw).toBe('string')
  })

  it('改动后稍等一会儿合并写入', async () => {
    const { useIndexedDBStorage, db } = await load()
    const { data, ready } = useIndexedDBStorage<Session[]>(KEY, [])
    await ready

    data.value.push({ id: 'a', title: '1' })
    await Promise.resolve()
    data.value.push({ id: 'b', title: '2' })
    await vi.waitFor(async () => {
      expect(await db.getJson(KEY)).toEqual([{ id: 'a', title: '1' }, { id: 'b', title: '2' }])
    }, { timeout: 2000 })
  })

  it('加载完成前的改动与保存的数据合并', async () => {
    const { useIndexedDBStorage, db } = await load()
    await db.setJson(KEY, [{ id: 'old', title: '保存的' }])

    const { data, ready } = useIndexedDBStorage<Session[]>(KEY, [], {
      merge: (stored, current) => [...current, ...stored],
    })
    data.value = [{ id: 'new', title: '刚建的' }]
    await ready
    expect(data.value.map((session) => session.id)).toEqual(['new', 'old'])

    flushPending()
    await vi.waitFor(async () => {
      expect(await db.getJson<Session[]>(KEY)).toHaveLength(2)
    }, { timeout: 2000 })
  })

  it('读取失败时不写入，避免用初始值覆盖保存的数据', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { useIndexedDBStorage } = await load()
    vi.stubGlobal('indexedDB', { open: () => { throw new Error('数据库打不开') } })

    const { data, ready } = useIndexedDBStorage<Session[]>(KEY, [])
    await ready
    data.value.push({ id: 'a', title: '1' })
    await Promise.resolve()
    flushPending()
    // 等过写入的延迟：如果尝试了写入，会因为数据库打不开而报「保存失败」
    await new Promise((resolve) => setTimeout(resolve, 700))

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('读取 chat/sessions 失败'), expect.anything())
  })
})
