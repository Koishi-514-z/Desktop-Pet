import type { Ref } from 'vue'
import { ref, watch } from 'vue'
import { getJson, setJson } from '@/utils/db'

// 改动后多久写入 IndexedDB：流式回复时内容每秒变化很多次，合并成一次写入
const WRITE_DELAY = 500

export interface IndexedDBStorageOptions<T> {
  /**
   * 加载完成之前数据就被改动了（如启动后立刻发了消息）时，如何合并保存的数据与当前的数据；
   * 不提供时以保存的数据为准
   */
  merge?: (stored: T, current: T) => T
}

/**
 * 与 useLocalStorage 类似的响应式存储，数据以 JSON 字符串整体保存在 IndexedDB 中（不受 localStorage 约 5MB 的容量限制）。
 *
 * IndexedDB 只能异步读取：返回的 data 一开始是 initial，加载完成后才是保存的数据，需要时等待 ready。
 * 第一次使用时，会把 localStorage 中同名的旧数据迁移过来。
 */
export function useIndexedDBStorage<T>(key: string, initial: T, options: IndexedDBStorageOptions<T> = {}) {
  const data = ref(initial) as Ref<T>
  let loaded = false
  // 读取失败时不写入，避免用初始值覆盖掉保存的数据
  let failed = false
  let changedBeforeLoad = false
  let timer: ReturnType<typeof setTimeout> | undefined

  function save() {
    clearTimeout(timer)
    timer = undefined
    setJson(key, data.value).catch((error) => console.warn(`[storage] 保存 ${key} 失败：`, error))
  }

  function scheduleSave() {
    if (failed) return
    if (!loaded) {
      changedBeforeLoad = true
      return
    }
    timer ??= setTimeout(save, WRITE_DELAY)
  }

  watch(data, scheduleSave, { deep: true })

  // 窗口关闭或隐藏前，立即写入还没保存的改动
  function flush() {
    if (timer !== undefined) save()
  }
  window.addEventListener('pagehide', flush)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })

  async function load() {
    let stored: T | undefined
    try {
      stored = await getJson<T>(key)
    }
    catch (error) {
      failed = true
      console.warn(`[storage] 读取 ${key} 失败，本次的改动不会保存：`, error)
      return
    }

    if (stored === undefined) stored = await migrateFromLocalStorage<T>(key)
    if (stored !== undefined) {
      data.value = changedBeforeLoad && options.merge ? options.merge(stored, data.value) : stored
    }
    loaded = true
    if (changedBeforeLoad) scheduleSave()
  }

  const ready = load()
  return { data, ready }
}

/** 把 localStorage 中的旧数据迁移到 IndexedDB，成功后删除旧数据 */
async function migrateFromLocalStorage<T>(key: string): Promise<T | undefined> {
  const text = localStorage.getItem(key)
  if (text === null) return undefined

  let value: T
  try {
    value = JSON.parse(text) as T
  }
  catch {
    console.warn(`[storage] localStorage 中的 ${key} 无法解析，没有迁移`)
    return undefined
  }

  try {
    await setJson(key, value)
    localStorage.removeItem(key)
    console.info(`[storage] 已把 ${key} 从 localStorage 迁移到 IndexedDB`)
  }
  catch (error) {
    // 迁移失败时保留旧数据，下次启动再试；本次仍然使用读到的数据
    console.warn(`[storage] 迁移 ${key} 失败：`, error)
  }
  return value
}
