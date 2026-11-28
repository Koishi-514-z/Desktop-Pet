import type { ModelMessage } from 'ai'
import { messageText } from '@/agent/utils'
import { formatSize } from '@/files/api'
import { DOCUMENTS_STORE, withStore } from '@/utils/db'

/**
 * 对话中的文档（Word、PowerPoint、Excel、PDF）：拖进对话框或通过「添加附件」选择的文件。
 * 网页拿不到文件在电脑上的位置，所以把文件内容保存在 IndexedDB 中，消息里只记录 id、文件名与大小，
 * 并以「【附文件：id｜文件名｜大小】」的标记告诉模型，由「Office 文档」技能提取内容。提取结果也保存在这里，追问时不用重新提取。
 */

/**
 * 「Office 文档」技能的 id。定义在这里而不是技能文件中：Agent 的入口按消息中的文件标记预先加载这个技能，
 * 从技能文件引用会形成循环依赖（技能 → stores → 技能列表）
 */
export const OFFICE_SKILL_ID = 'office'

/** 提取出的文字 */
export interface ExtractedText {
  content: string
  /** docx、pptx、pdf、spreadsheet */
  format: string
  /** 内容的总字数（content 可能被截断） */
  totalChars: number
}

export interface StoredDocument {
  id: string
  name: string
  mediaType: string
  size: number
  data: Blob
  createdAt: number
  extracted?: ExtractedText
}

/** 消息中引用的文档 */
export interface DocumentRef {
  id: string
  name: string
  size: number
}

/** 一条消息最多附带几个文档 */
export const MAX_DOCUMENTS = 5
/** 文档最大多少字节 */
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024

/** 可以提取内容的文档类型 */
export const DOCUMENT_EXTENSIONS = ['docx', 'pptx', 'xlsx', 'xlsm', 'xls', 'xlsb', 'ods', 'pdf']
/** 旧版的 Office 格式：可以识别，但不能提取，需要先另存为新格式 */
const OLD_EXTENSIONS = ['doc', 'ppt']

function extensionOf(name: string): string {
  return /\.([^.\\/]+)$/.exec(name)?.[1]?.toLowerCase() ?? ''
}

/** 文件是不是文档（按扩展名判断；旧版的 .doc / .ppt 也算，添加时提示另存为新格式） */
export function isDocumentFile(file: Pick<File, 'name'>): boolean {
  const extension = extensionOf(file.name)
  return DOCUMENT_EXTENSIONS.includes(extension) || OLD_EXTENSIONS.includes(extension)
}

export function createDocumentId(): string {
  const random = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    : Math.random().toString(36).slice(2, 14)
  return `doc_${random}`
}

/** 保存一个文档，返回在消息中引用的信息 */
export async function addDocument(file: Blob, name = (file as File).name || '文档'): Promise<DocumentRef> {
  const extension = extensionOf(name)
  if (OLD_EXTENSIONS.includes(extension)) {
    throw new Error(`暂不支持旧版的 .${extension} 文件，可以先用 Office 另存为 .${extension}x`)
  }
  if (!DOCUMENT_EXTENSIONS.includes(extension)) throw new Error(`不支持的文件类型：${name}`)
  if (file.size > MAX_DOCUMENT_BYTES) throw new Error(`文件太大（超过 ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB）`)
  const document: StoredDocument = {
    id: createDocumentId(),
    name,
    mediaType: file.type,
    size: file.size,
    data: file,
    createdAt: Date.now(),
  }
  await withStore(DOCUMENTS_STORE, 'readwrite', (store) => store.put(document))
  return { id: document.id, name: document.name, size: document.size }
}

export async function loadDocument(id: string): Promise<StoredDocument | undefined> {
  return withStore<StoredDocument>(DOCUMENTS_STORE, 'readonly', (store) => store.get(id))
}

/** 保存提取结果 */
export async function saveExtracted(id: string, extracted: ExtractedText): Promise<void> {
  const document = await loadDocument(id)
  if (!document) return
  await withStore(DOCUMENTS_STORE, 'readwrite', (store) => store.put({ ...document, extracted }))
}

export async function deleteDocuments(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await withStore(DOCUMENTS_STORE, 'readwrite', (store) => {
    ids.forEach((id) => store.delete(id))
  })
}

const DOCUMENT_MARKER_REGEX = /【附文件：([\w-]+)/g

/** 附加在用户消息末尾的文档标记 */
export function documentMarkers(documents: DocumentRef[]): string {
  return documents.map((document) => `【附文件：${document.id}｜${document.name}｜${formatSize(document.size)}】`).join('\n')
}

export function parseDocumentIds(text: string): string[] {
  return [...text.matchAll(DOCUMENT_MARKER_REGEX)].map((match) => match[1]!)
}

/** 对话中最近一条带文档的用户消息中的文档 */
export function findLatestDocumentIds(messages: ModelMessage[]): string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role !== 'user') continue
    const ids = parseDocumentIds(messageText(message))
    if (ids.length) return ids
  }
  return []
}
