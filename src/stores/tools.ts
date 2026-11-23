import type { FileMove, NamedFolder, WriteResult } from '@/files/api'
import type { SearchSettings } from '@/web/search'
import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed } from 'vue'
import * as files from '@/files/api'

// 最多保留的文件操作记录（用于撤销）
const MAX_FILE_HISTORY = 20

/** 一次文件写入（新建或修改） */
export interface FileWrite {
  path: string
  /** 是否为新建的文件：撤销时删除它 */
  created: boolean
  /** 原文件的备份：撤销时恢复 */
  backupId: string | null
  /** 写入后的内容哈希：文件之后又被改动过时不撤销 */
  afterHash: string
}

/** 一次文件操作（整理、移动、写入），可以撤销 */
export interface FileOperation {
  id: string
  /** 操作说明，如「整理 下载」 */
  description: string
  /** 移动的文件；写入操作为空 */
  moves: FileMove[]
  /** 写入的文件 */
  write?: FileWrite
  createdAt: number
  undone: boolean
}

function createOperationId(): string {
  return `files-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

// 工具设置：网页搜索服务、授权访问的文件夹与文件操作记录
export const useToolsStore = defineStore('tools', () => {
  const search = useLocalStorage<SearchSettings>(
    'settings/tools/search',
    { provider: 'none', tavilyKey: '', braveKey: '', searxngUrl: '' },
    { mergeDefaults: true },
  )

  // 授权访问的文件夹；第一次使用时自动加入桌面、文档、下载、图片
  const fileRoots = useLocalStorage<NamedFolder[]>('settings/tools/fileRoots', [])
  const fileRootsInitialized = useLocalStorage('settings/tools/fileRootsInitialized', false)
  const fileHistory = useLocalStorage<FileOperation[]>('tools/fileHistory', [])

  const rootPaths = computed(() => fileRoots.value.map((root) => root.path))

  async function init() {
    if (!files.filesAvailable || fileRootsInitialized.value) return
    try {
      fileRoots.value = await files.getDefaultRoots()
      fileRootsInitialized.value = true
    }
    catch (error) {
      console.warn('[tools] 获取默认文件夹失败：', error)
    }
  }

  /** 授权一个文件夹，返回规范化后的路径 */
  async function addRoot(path: string, name?: string): Promise<NamedFolder> {
    const resolved = await files.validateRoot(path)
    const existing = fileRoots.value.find((root) => root.path === resolved)
    if (existing) return existing
    const folder = { name: name?.trim() || resolved.split(/[\\/]/).filter(Boolean).pop() || resolved, path: resolved }
    fileRoots.value = [...fileRoots.value, folder]
    return folder
  }

  function removeRoot(path: string) {
    fileRoots.value = fileRoots.value.filter((root) => root.path !== path)
  }

  /**
   * 把用户或 LLM 给出的路径解析为完整路径：
   * 支持以授权文件夹的名称开头（如「下载」「下载/发票」），其余原样返回（由 Rust 端校验）
   */
  function resolvePath(path: string): string {
    const trimmed = path.trim().replace(/^["'「]|["'」]$/g, '')
    for (const root of fileRoots.value) {
      if (trimmed === root.name) return root.path
      for (const separator of ['/', '\\']) {
        const prefix = `${root.name}${separator}`
        if (trimmed.startsWith(prefix)) return `${root.path}${root.path.includes('\\') ? '\\' : '/'}${trimmed.slice(prefix.length)}`
      }
    }
    return trimmed
  }

  function record(operation: Omit<FileOperation, 'id' | 'createdAt' | 'undone'>): FileOperation {
    const item: FileOperation = { id: createOperationId(), createdAt: Date.now(), undone: false, ...operation }
    fileHistory.value = [item, ...fileHistory.value].slice(0, MAX_FILE_HISTORY)
    return item
  }

  function recordMoves(description: string, moves: FileMove[]): FileOperation | null {
    return moves.length ? record({ description, moves }) : null
  }

  function recordWrite(description: string, result: WriteResult): FileOperation {
    const { path, created, backupId, afterHash } = result
    return record({ description, moves: [], write: { path, created, backupId, afterHash } })
  }

  /**
   * 撤销一次文件操作，返回结果说明：
   * 移动的文件移回原处（原处已有同名文件时会加上编号）；修改的文件恢复原内容，新建的文件被删除
   */
  async function undoOperation(id: string): Promise<string> {
    const operation = fileHistory.value.find((item) => item.id === id)
    if (!operation || operation.undone) throw new Error('这次操作已经撤销过了')

    let message: string
    if (operation.write) {
      const { path, backupId, afterHash, created } = operation.write
      await files.undoWrite(rootPaths.value, path, backupId, afterHash)
      message = created ? '已删除新建的文件' : '已恢复文件原来的内容'
    }
    else {
      const reverse = [...operation.moves].reverse().map(({ from, to }) => ({ from: to, to: from }))
      const report = await files.moveFiles(rootPaths.value, reverse)
      message = report.failed.length
        ? `已移回 ${report.moved.length} 个文件，${report.failed.length} 个没能移回：${report.failed[0]!.error}`
        : `已把 ${report.moved.length} 个文件移回原处`
    }
    fileHistory.value = fileHistory.value.map((item) => (item.id === id ? { ...item, undone: true } : item))
    return message
  }

  return {
    search,
    fileRoots,
    fileHistory,
    rootPaths,
    init,
    addRoot,
    removeRoot,
    resolvePath,
    recordMoves,
    recordWrite,
    undoOperation,
  }
})
