import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/composables/desktop'

// 对 Rust 端文件命令的封装。所有操作都只能在授权的文件夹内进行（每次都会在 Rust 端重新校验）

export interface NamedFolder {
  name: string
  path: string
}

export interface FileEntry {
  path: string
  name: string
  isDir: boolean
  size: number
  /** 修改时间，毫秒时间戳 */
  modifiedAt: number | null
  /** 小写的扩展名，不含点 */
  extension: string
}

export interface FileSearchRequest {
  /** 在这些文件夹中查找，为空时查找所有授权文件夹 */
  folders?: string[]
  /** 文件名需要包含的所有关键词 */
  keywords?: string[]
  /** 文件类型（扩展名，不含点） */
  extensions?: string[]
  /** 文件内容需要包含的文字（只检查文本文件） */
  contains?: string
  modifiedAfter?: number
  modifiedBefore?: number
  minSize?: number
  maxSize?: number
  includeDirs?: boolean
  limit?: number
}

export interface FileSearchResult {
  entries: FileEntry[]
  scanned: number
  truncated: boolean
}

export interface FileContent {
  path: string
  name: string
  size: number
  content: string
  truncated: boolean
  totalChars: number
  format: 'text' | 'docx' | 'pptx'
  encoding: string | null
}

export type OrganizeBy = 'type' | 'month' | 'extension'

export interface FileMove {
  from: string
  to: string
}

export interface TextEdit {
  /** 要替换的原文，必须在文件中只出现一次 */
  oldText: string
  newText: string
}

export interface CellEdit {
  /** 工作表名称，省略时为第一个工作表 */
  sheet?: string
  /** 单元格位置，如 B3 */
  cell: string
  /** 新的值：以 = 开头为公式 */
  value: string
}

export interface WriteRequest {
  path: string
  /** 文件的完整内容：新建文件，或覆盖整个文件（Word 为简单的 Markdown，Excel 为 CSV 或 Markdown 表格） */
  content?: string
  /** 文件已存在时是否允许覆盖 */
  overwrite?: boolean
  /** 依次执行的查找替换（Word、PowerPoint 中不能跨段落） */
  edits?: TextEdit[]
  /** 追加到文件末尾的内容；Excel 中为追加到工作表末尾的行 */
  append?: string
  /** 修改 Excel 单元格 */
  cells?: CellEdit[]
  /** Excel 中追加行的工作表 */
  sheet?: string
}

export interface WritePreview {
  path: string
  created: boolean
  /** 原文件内容的哈希；新建文件时为 null */
  beforeHash: string | null
  afterHash: string
  /** 一句话说明，如「修改了 2 处」 */
  summary: string
  /** 改动预览：- 开头为删除的行，+ 开头为新增的行 */
  preview: string
  /** 写入使用的编码，Office 文件为文件类型 */
  encoding: string
  /** 需要提醒用户的注意事项 */
  warning: string | null
}

export interface WriteResult {
  path: string
  created: boolean
  /** 原文件的备份，用于撤销；新建文件时为 null */
  backupId: string | null
  afterHash: string
  summary: string
  preview: string
}

export interface MoveReport {
  moved: FileMove[]
  failed: { from: string, error: string }[]
}

function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isTauri) return Promise.reject(new Error('本地文件操作需要在桌面应用中使用'))
  return invoke<T>(command, args)
}

export const filesAvailable = isTauri

export function getDefaultRoots(): Promise<NamedFolder[]> {
  return call('files_default_roots')
}

/** 检查一个文件夹能否被授权，返回规范化后的路径 */
export function validateRoot(path: string): Promise<string> {
  return call('files_validate_root', { path })
}

export function searchFiles(roots: string[], request: FileSearchRequest): Promise<FileSearchResult> {
  return call('files_search', { roots, request })
}

export function listFolder(roots: string[], folder: string, limit?: number): Promise<{ entries: FileEntry[], total: number }> {
  return call('files_list', { roots, folder, limit: limit ?? null })
}

export function readFile(roots: string[], path: string, maxChars?: number): Promise<FileContent> {
  return call('files_read', { roots, path, maxChars: maxChars ?? null })
}

/** 生成整理计划（不会移动文件） */
export function planOrganize(roots: string[], folder: string, by: OrganizeBy): Promise<FileMove[]> {
  return call('files_plan_organize', { roots, folder, by, utcOffsetMinutes: -new Date().getTimezoneOffset() })
}

/** 执行移动，目标重名时自动加上编号 */
export function moveFiles(roots: string[], moves: FileMove[]): Promise<MoveReport> {
  return call('files_move', { roots, moves })
}

export function createFolder(roots: string[], path: string): Promise<string> {
  return call('files_create_folder', { roots, path })
}

/** 生成写入预览（不会改动文件） */
export function previewWrite(roots: string[], request: WriteRequest): Promise<WritePreview> {
  return call('files_preview_write', { roots, request })
}

/** 写入文件；expectedHash 为预览时原文件的哈希，文件在这期间被改动过时不写入 */
export function writeFile(roots: string[], request: WriteRequest, expectedHash: string | null): Promise<WriteResult> {
  return call('files_write', { roots, request, expectedHash })
}

/** 撤销一次写入：恢复原内容，新建的文件则删除；文件之后又被改动过时不撤销 */
export function undoWrite(roots: string[], path: string, backupId: string | null, afterHash: string): Promise<void> {
  return call('files_undo_write', { roots, path, backupId, afterHash })
}

/** 在系统的文件管理器中显示文件 */
export function revealFile(roots: string[], path: string): Promise<void> {
  return call('files_reveal', { roots, path })
}

/** 用系统浏览器打开网址；在浏览器中运行时打开新标签页 */
export async function openUrl(url: string): Promise<void> {
  if (isTauri) {
    await invoke('open_url', { url })
    return
  }
  window.open(url, '_blank', 'noopener')
}

/** 文件大小的可读形式 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}
