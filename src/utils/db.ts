/**
 * 应用的 IndexedDB 数据库：保存 localStorage 放不下的数据。
 * - images：对话中的图片
 * - kv：以 JSON 字符串整体保存的较大数据（如对话会话），键为数据的名称
 * - audios：对话中的音频文件（连同转录结果）
 * - documents：对话中的文档（Word、PowerPoint、Excel、PDF，连同提取出的文字）
 * - favorites：收藏的桌宠语音（文字与音频）
 */

const DB_NAME = 'desktop-pet'
// 版本 2 新增了 kv，版本 3 新增了 audios，版本 4 新增了 documents，版本 5 新增了 favorites
const DB_VERSION = 5
export const IMAGES_STORE = 'images'
export const KV_STORE = 'kv'
export const AUDIOS_STORE = 'audios'
export const DOCUMENTS_STORE = 'documents'
export const FAVORITES_STORE = 'favorites'

let dbPromise: Promise<IDBDatabase> | null = null

export function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(IMAGES_STORE)) db.createObjectStore(IMAGES_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE)
      if (!db.objectStoreNames.contains(AUDIOS_STORE)) db.createObjectStore(AUDIOS_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(DOCUMENTS_STORE)) db.createObjectStore(DOCUMENTS_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(FAVORITES_STORE)) db.createObjectStore(FAVORITES_STORE, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      dbPromise = null
      reject(request.error)
    }
  })
  return dbPromise
}

/** 在一个事务中操作某个存储，事务完成后返回请求的结果 */
export async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode)
    const request = run(transaction.objectStore(storeName))
    transaction.oncomplete = () => resolve(request ? request.result : undefined)
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

/** 读取以 JSON 字符串保存的数据，没有时返回 undefined */
export async function getJson<T>(key: string): Promise<T | undefined> {
  const text = await withStore<string | undefined>(KV_STORE, 'readonly', (store) => store.get(key))
  return typeof text === 'string' ? JSON.parse(text) as T : undefined
}

/** 把数据整体序列化为 JSON 字符串保存 */
export async function setJson(key: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value)
  await withStore(KV_STORE, 'readwrite', (store) => store.put(text, key))
}
