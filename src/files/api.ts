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
  format: 'text' | 'docx' | 'pptx' | 'pdf' | 'spreadsheet'
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

export interface WriteRequest {
  path: string
  /** 文件的完整内容：新建文件，或覆盖整个文件 */
  content?: string
  /** 文件已存在时是否允许覆盖 */
  overwrite?: boolean
  /** 依次执行的查找替换 */
  edits?: TextEdit[]
  /** 追加到文件末尾的内容 */
  append?: string
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
  /** 写入使用的编码 */
  encoding: string
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

/** 读取授权文件夹中的文件的原始字节（如音频），超过 maxBytes 时报错 */
export async function readFileBytes(roots: string[], path: string, maxBytes: number): Promise<Uint8Array> {
  return new Uint8Array(await call<ArrayBuffer>('files_read_bytes', { roots, path, maxBytes }))
}

/**
 * 读取拖进对话框的文件的文字（不知道它在电脑上的位置，只能把内容发给 Rust 端）。
 * 内容以原始字节发送，不经过 JSON；name 用来判断文件类型。返回结果中的 path 为空
 */
export function extractFileText(name: string, data: ArrayBuffer, maxChars?: number): Promise<FileContent> {
  if (!isTauri) return Promise.reject(new Error('提取文档内容需要在桌面应用中使用'))
  return invoke<FileContent>('files_extract_bytes', new Uint8Array(data), {
    headers: { 'x-file-name': encodeURIComponent(name), ...(maxChars ? { 'x-max-chars': String(maxChars) } : {}) },
  })
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

/**
 * 撤销一次写入：恢复原内容，新建的文件则删除，被脚本删除的文件（afterHash 为 null）从备份恢复；
 * 文件之后又被改动过时不撤销
 */
export function undoWrite(roots: string[], path: string, backupId: string | null, afterHash: string | null): Promise<void> {
  return call('files_undo_write', { roots, path, backupId, afterHash })
}

/** 在系统的文件管理器中显示文件 */
export function revealFile(roots: string[], path: string): Promise<void> {
  return call('files_reveal', { roots, path })
}

// ===== 运行脚本 =====

export interface ScriptRuntime {
  /** 脚本类型，如「Python 脚本」 */
  kind: string
  /** 解释器路径；没有找到时为 null */
  path: string | null
}

export interface RunScriptRequest {
  /** 运行 id，用于取消 */
  runId: string
  path: string
  args?: string[]
  /** 工作目录，省略时为脚本所在的文件夹 */
  workingDir?: string
  timeoutSeconds?: number
}

/** 运行前展示给用户确认的信息 */
export interface ScriptInfo {
  path: string
  name: string
  kind: string
  /** 完整的命令 */
  command: string
  workingDir: string
  timeoutSeconds: number
  /** 脚本内容的开头 */
  preview: string
  lines: number
  previewTruncated: boolean
}

export interface ScriptResult {
  command: string
  /** 退出码；被结束时为 null */
  exitCode: number | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  timedOut: boolean
  cancelled: boolean
  durationMs: number
  /** 补充说明，如结束了残留的 Office 后台进程 */
  note: string | null
}

// ===== 由脚本修改的文件 =====

/** 运行前对一个文件的检查结果 */
export interface TargetInfo {
  path: string
  /** 文件是否已经存在（不存在表示将由脚本新建） */
  exists: boolean
  size: number
}

/** 运行前的快照 */
export interface TargetSnapshot {
  path: string
  backupId: string | null
  beforeHash: string | null
}

/** 运行后一个文件的改动 */
export interface TargetChange {
  path: string
  /** 内容有变化（包括新建与删除） */
  changed: boolean
  created: boolean
  deleted: boolean
  /** 运行前的备份，用于撤销 */
  backupId: string | null
  /** 运行后的内容哈希；文件被删除时为 null */
  afterHash: string | null
  /** 无法确认改动时的原因（如文件仍被占用） */
  error: string | null
}

/** 运行前检查脚本会新建或修改的文件：在授权的文件夹内、没有被其他程序打开（不会改动文件） */
export function checkTargets(roots: string[], paths: string[]): Promise<TargetInfo[]> {
  return call('files_check_targets', { roots, paths })
}

/** 运行前备份脚本会修改的文件 */
export function snapshotTargets(roots: string[], paths: string[]): Promise<TargetSnapshot[]> {
  return call('files_snapshot_targets', { roots, paths })
}

/** 运行后对比文件，返回改动 */
export function settleTargets(roots: string[], snapshots: TargetSnapshot[]): Promise<TargetChange[]> {
  return call('files_settle_targets', { roots, snapshots })
}

/** 本机可以用来新建与修改 Office 文件的方式 */
export interface OfficeSupport {
  /** 已安装的 Microsoft Office 程序 */
  word: boolean
  excel: boolean
  powerpoint: boolean
  /** 已安装的 Python 库：python-docx、openpyxl、python-pptx */
  pythonLibraries: string[]
  /** 用来把 HTML 打印成 PDF 的浏览器（Edge、Chrome）；没有时为 null */
  pdfBrowser: string | null
}

export function getOfficeSupport(): Promise<OfficeSupport> {
  return call('office_support')
}

export interface PdfPrintRequest {
  /** 运行 id，用于取消（与脚本共用 cancelScript） */
  runId: string
  /** 要生成的 PDF 的完整路径 */
  path: string
  html: string
  timeoutSeconds?: number
}

export interface PdfPrintResult {
  path: string
  pages: number
  size: number
  /** 用来打印的浏览器 */
  browser: string
  durationMs: number
  cancelled: boolean
  timedOut: boolean
}

/** 把 HTML 打印成 PDF。调用前必须已经征得用户同意，并备份要覆盖的文件 */
export function printHtmlToPdf(roots: string[], request: PdfPrintRequest): Promise<PdfPrintResult> {
  return call('pdf_print_html', { roots, request })
}

/** 新 PDF 中的一部分：某个 PDF 的若干页 */
export interface PdfPart {
  path: string
  /** 页码，如「1-3,5,8-」「10-1」（倒序）；省略时为全部页面 */
  pages?: string
  /** 顺时针旋转的角度（90 的倍数） */
  rotate?: number
}

/** 要生成的一个 PDF：依次由几部分组成 */
export interface PdfOutput {
  path: string
  parts: PdfPart[]
}

export interface PdfPartPlan {
  path: string
  /** 源文件的总页数 */
  totalPages: number
  /** 选中的页码，按新文件中的顺序 */
  pages: number[]
  rotate: number
}

export interface PdfOutputPlan {
  path: string
  /** 文件已经存在（将被覆盖） */
  exists: boolean
  pages: number
  parts: PdfPartPlan[]
}

export interface PdfOutputResult {
  path: string
  pages: number
  size: number
}

/** 检查按页重新组合 PDF 的计划（不会改动文件） */
export function planPdfCompose(roots: string[], outputs: PdfOutput[]): Promise<PdfOutputPlan[]> {
  return call('pdf_plan_compose', { roots, outputs })
}

/** 按页重新组合 PDF：合并、拆分、提取、删除、调整顺序、旋转页面。调用前必须已经征得用户同意，并备份要覆盖的文件 */
export function composePdf(roots: string[], outputs: PdfOutput[]): Promise<PdfOutputResult[]> {
  return call('pdf_compose', { roots, outputs })
}

/** 本机可用的脚本解释器 */
export function getScriptRuntimes(): Promise<ScriptRuntime[]> {
  return call('script_runtimes')
}

/** 检查脚本能否运行，返回命令与脚本内容（不会运行脚本） */
export function inspectScript(roots: string[], request: RunScriptRequest): Promise<ScriptInfo> {
  return call('script_inspect', { roots, request })
}

/** 运行脚本，等待结束后返回输出。调用前必须已经征得用户同意 */
export function runScript(roots: string[], request: RunScriptRequest): Promise<ScriptResult> {
  return call('script_run', { roots, request })
}

/** 直接运行的代码的语言 */
export type CodeLanguage = 'python' | 'javascript' | 'powershell' | 'batch' | 'shell'

export interface RunCodeRequest {
  /** 运行 id，用于取消 */
  runId: string
  language: CodeLanguage
  code: string
  args?: string[]
  /** 工作目录，省略时为第一个授权文件夹 */
  workingDir?: string
  timeoutSeconds?: number
  /** 运行结束后，结束脚本启动的、没有正常退出的 Office 后台进程（通过 COM 调用 Office 时使用） */
  cleanupOffice?: boolean
}

/** 检查一段代码能否运行，返回命令与完整代码（不会运行） */
export function inspectCode(roots: string[], request: RunCodeRequest): Promise<ScriptInfo> {
  return call('script_inspect_code', { roots, request })
}

/** 直接运行一段代码，不写入用户的文件夹。调用前必须已经征得用户同意 */
export function runCode(roots: string[], request: RunCodeRequest): Promise<ScriptResult> {
  return call('script_run_code', { roots, request })
}

/** 取消正在运行的脚本 */
export function cancelScript(runId: string): Promise<boolean> {
  return call('script_cancel', { runId })
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
