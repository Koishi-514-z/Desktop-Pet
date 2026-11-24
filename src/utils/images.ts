import { reactive } from 'vue'
import { IMAGES_STORE, withStore as withDbStore } from '@/utils/db'

/**
 * 对话中的图片：数据保存在 IndexedDB 中（localStorage 容量太小，放不下截图），
 * 消息里只记录图片 id 与尺寸。
 */
export interface StoredImage {
  id: string
  /** 图片的 data URL */
  dataUrl: string
  mediaType: string
  width: number
  height: number
  createdAt: number
}

/** 消息中引用的图片 */
export interface ImageRef {
  id: string
  width: number
  height: number
}

// 发送给模型前，图片最长边超过该值时会被缩小
const MAX_SIDE = 2048
// 不超过该大小、尺寸也合适的图片保持原样，避免重新编码让截图中的文字变模糊
const MAX_ORIGINAL_BYTES = 2 * 1024 * 1024
const SUPPORTED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return withDbStore(IMAGES_STORE, mode, run)
}

export function createImageId(): string {
  const random = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    : Math.random().toString(36).slice(2, 14)
  return `img_${random}`
}

// 已加载过的图片，供界面同步读取缩略图
const cache = reactive(new Map<string, string>())
const loading = new Set<string>()

export async function saveImage(image: StoredImage): Promise<ImageRef> {
  await withStore('readwrite', (store) => store.put(image))
  cache.set(image.id, image.dataUrl)
  return { id: image.id, width: image.width, height: image.height }
}

export async function loadImage(id: string): Promise<StoredImage | undefined> {
  return withStore<StoredImage>('readonly', (store) => store.get(id))
}

export async function deleteImages(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  ids.forEach((id) => cache.delete(id))
  await withStore('readwrite', (store) => {
    ids.forEach((id) => store.delete(id))
  })
}

/** 同步获取图片地址用于展示；尚未加载时返回空字符串，并在后台加载（加载完成后界面会自动更新） */
export function imageSrc(id: string): string {
  const cached = cache.get(id)
  if (cached) return cached

  if (!loading.has(id)) {
    loading.add(id)
    loadImage(id)
      .then((image) => {
        if (image) cache.set(id, image.dataUrl)
      })
      .catch((error) => console.warn('[images] 加载图片失败：', error))
      .finally(() => loading.delete(id))
  }
  return ''
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

function loadElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('无法读取图片，可能不是有效的图片文件'))
    img.src = src
  })
}

/** data URL 的媒体类型与解码后的大致字节数 */
function inspectDataUrl(dataUrl: string): { mediaType: string, bytes: number } {
  const match = dataUrl.match(/^data:([^;,]+)[^,]*,/)
  const payload = dataUrl.length - (match?.[0].length ?? 0)
  return { mediaType: match?.[1] ?? '', bytes: Math.floor(payload * 3 / 4) }
}

/**
 * 将粘贴、拖入、截图得到的图片整理为可以发送给模型的格式：
 * 尺寸过大或格式不受支持时缩放并重新编码为 JPEG，否则保持原样。
 */
export async function prepareImage(source: Blob | string): Promise<StoredImage> {
  const dataUrl = typeof source === 'string' ? source : await readAsDataUrl(source)
  const { mediaType, bytes } = inspectDataUrl(dataUrl)
  if (!mediaType.startsWith('image/')) throw new Error('不是图片文件')

  const img = await loadElement(dataUrl)
  const width = img.naturalWidth
  const height = img.naturalHeight
  const base = { id: createImageId(), createdAt: Date.now() }

  if (SUPPORTED_TYPES.includes(mediaType) && Math.max(width, height) <= MAX_SIDE && bytes <= MAX_ORIGINAL_BYTES) {
    return { ...base, dataUrl, mediaType, width, height }
  }

  const scale = Math.min(1, MAX_SIDE / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法处理图片')
  // JPEG 不支持透明，先铺白底
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(img, 0, 0, canvas.width, canvas.height)

  return {
    ...base,
    dataUrl: canvas.toDataURL('image/jpeg', 0.92),
    mediaType: 'image/jpeg',
    width: canvas.width,
    height: canvas.height,
  }
}

/** 整理并保存一张图片，返回其引用 */
export async function addImage(source: Blob | string): Promise<ImageRef> {
  return saveImage(await prepareImage(source))
}
