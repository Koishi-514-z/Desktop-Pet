import type { PermissionRequest } from '@/agent/types'
import type { FileEntry, FileMove, WritePreview } from '@/files/api'
import { MockLanguageModelV3 } from 'ai/test'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runAgent } from '@/agent'
import { filesSkill, summarizeMoves } from '@/agent/skills/files'
import { useToolsStore } from '@/stores/tools'

// 模拟 Rust 端的文件命令
const fs = vi.hoisted(() => ({
  calls: [] as { command: string, args: unknown[] }[],
  plan: [] as { from: string, to: string }[],
  previewError: null as string | null,
  // read_file 读到的文件内容
  text: '',
  // list_folder / folder_tree 看到的文件夹：路径 → 其中的条目
  tree: {} as Record<string, FileEntry[]>,
}))

const CONFIG = 'C:\\Users\\me\\Desktop\\config.json'
const PREVIEW: WritePreview = {
  path: CONFIG,
  created: false,
  beforeHash: 'hash-before',
  afterHash: 'hash-after',
  summary: '修改了 1 处',
  preview: '第 3 行：\n-   "port": 8080\n+   "port": 9090',
  encoding: 'UTF-8',
}

vi.mock('@/files/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/files/api')>()),
  filesAvailable: true,
  planOrganize: async (...args: unknown[]) => {
    fs.calls.push({ command: 'plan', args })
    return fs.plan
  },
  moveFiles: async (roots: string[], moves: FileMove[]) => {
    fs.calls.push({ command: 'move', args: [roots, moves] })
    return { moved: moves, failed: [] }
  },
  previewWrite: async (...args: unknown[]) => {
    fs.calls.push({ command: 'preview', args })
    if (fs.previewError) throw new Error(fs.previewError)
    return PREVIEW
  },
  writeFile: async (...args: unknown[]) => {
    fs.calls.push({ command: 'write', args })
    return { path: CONFIG, created: false, backupId: 'backup-1', afterHash: 'hash-after', summary: PREVIEW.summary, preview: PREVIEW.preview }
  },
  undoWrite: async (...args: unknown[]) => {
    fs.calls.push({ command: 'undo', args })
  },
  searchFiles: async (...args: unknown[]) => {
    fs.calls.push({ command: 'search', args })
    return { entries: [{ path: 'C:\\Users\\me\\Downloads\\合同.pdf', name: '合同.pdf', isDir: false, size: 2048, modifiedAt: 0, extension: 'pdf' }], scanned: 10, truncated: false }
  },
  // 与 Rust 端一样按字符计数，读取前 maxChars 字
  readFile: async (roots: string[], path: string, maxChars: number) => {
    fs.calls.push({ command: 'read', args: [roots, path, maxChars] })
    const chars = Array.from(fs.text)
    return {
      path,
      name: path.split('\\').pop(),
      size: fs.text.length,
      content: chars.slice(0, maxChars).join(''),
      truncated: chars.length > maxChars,
      totalChars: chars.length,
      format: 'text',
      encoding: 'UTF-8',
    }
  },
  listFolder: async (roots: string[], folder: string, limit: number) => {
    fs.calls.push({ command: 'list', args: [roots, folder, limit] })
    const entries = fs.tree[folder]
    if (!entries) throw new Error(`${folder} 不是文件夹`)
    return { entries: entries.slice(0, limit), total: entries.length }
  },
}))

const DOWNLOADS = 'C:\\Users\\me\\Downloads'

beforeEach(() => {
  fs.calls = []
  fs.previewError = null
  fs.text = ''
  fs.tree = {}
  fs.plan = [
    { from: `${DOWNLOADS}\\a.jpg`, to: `${DOWNLOADS}\\图片\\a.jpg` },
    { from: `${DOWNLOADS}\\b.png`, to: `${DOWNLOADS}\\图片\\b.png` },
    { from: `${DOWNLOADS}\\合同.pdf`, to: `${DOWNLOADS}\\文档\\合同.pdf` },
  ]
  localStorage.clear()
  setActivePinia(createPinia())
  useToolsStore().fileRoots = [{ name: '下载', path: DOWNLOADS }, { name: '桌面', path: 'C:\\Users\\me\\Desktop' }]
})

function call(toolName: string, input: unknown, requestPermission?: (request: PermissionRequest) => Promise<boolean>) {
  return runAgent({
    model: new MockLanguageModelV3(),
    messages: [{ role: 'user', content: '整理一下下载文件夹' }],
    skills: [filesSkill],
    directCall: { skillId: 'files', toolName, input },
    requestPermission,
  })
}

describe('文件技能', () => {
  it('解析以授权文件夹名称开头的路径', () => {
    const store = useToolsStore()
    expect(store.resolvePath('下载')).toBe(DOWNLOADS)
    expect(store.resolvePath('「下载/发票/a.pdf」')).toBe(`${DOWNLOADS}\\发票/a.pdf`)
    expect(store.resolvePath('D:\\其他\\x.txt')).toBe('D:\\其他\\x.txt')
  })

  it('说明中列出授权的文件夹', () => {
    const instructions = typeof filesSkill.instructions === 'function' ? filesSkill.instructions() : filesSkill.instructions
    expect(instructions).toContain(`下载：${DOWNLOADS}`)
  })

  it('按目标文件夹汇总移动计划', () => {
    expect(summarizeMoves(fs.plan)).toBe('→ 图片/：a.jpg、b.png\n→ 文档/：合同.pdf')
  })

  it('整理前请求确认，确认后移动并记录，以便撤销', async () => {
    const requests: PermissionRequest[] = []
    const res = await call('organize_folder', { path: '下载', by: 'type' }, async (request) => {
      requests.push(request)
      return true
    })

    expect(fs.calls[0]!.args).toEqual([[DOWNLOADS, 'C:\\Users\\me\\Desktop'], DOWNLOADS, 'type'])
    expect(requests[0]).toMatchObject({ kind: 'files-write', allowAlways: false, targetLabel: '计划' })
    expect(requests[0]!.reason).toContain('3 个文件按文件类型')
    expect(fs.calls.find((c) => c.command === 'move')!.args[1]).toEqual(fs.plan)
    expect(res?.displays[0]?.title).toBe('整理文件夹：移动了 3 个文件')

    const history = useToolsStore().fileHistory
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ description: '整理「Downloads」（按文件类型）', moves: fs.plan, undone: false })
  })

  it('用户拒绝时不移动任何文件', async () => {
    const res = await call('organize_folder', { path: '下载', by: 'type' }, async () => false)
    expect(fs.calls.map((c) => c.command)).toEqual(['plan'])
    expect(res?.toolCalls[0]?.output).toMatchObject({ moved: 0 })
    expect(useToolsStore().fileHistory).toEqual([])
  })

  it('没有需要整理的文件时不请求确认', async () => {
    fs.plan = []
    const requestPermission = vi.fn<(request: PermissionRequest) => Promise<boolean>>(async () => true)
    await call('organize_folder', { path: '下载', by: 'month' }, requestPermission)
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it('修改文件前展示改动预览并请求确认，确认后写入并记录，以便撤销', async () => {
    const requests: PermissionRequest[] = []
    const edits = [{ oldText: '"port": 8080', newText: '"port": 9090' }]
    const res = await call('edit_file', { path: '桌面/config.json', edits, reason: '把端口改成 9090' }, async (request) => {
      requests.push(request)
      return true
    })

    expect(fs.calls[0]).toEqual({ command: 'preview', args: [[DOWNLOADS, 'C:\\Users\\me\\Desktop'], { path: 'C:\\Users\\me\\Desktop\\config.json', edits, append: undefined }] })
    expect(requests[0]).toMatchObject({ kind: 'files-write', title: '修改文件「config.json」', reason: '把端口改成 9090', targetFormat: 'code', allowAlways: false })
    expect(requests[0]!.target).toContain('+   "port": 9090')
    // 写入时带上预览时的哈希，文件在确认期间被改动过时不会写入
    expect(fs.calls[1]!.command).toBe('write')
    expect(fs.calls[1]!.args[2]).toBe('hash-before')
    expect(res?.toolCalls[0]?.output).toMatchObject({ written: true, summary: '修改了 1 处' })
    expect(res?.displays[0]).toMatchObject({ title: '修改文件：config.json', format: 'code' })

    const store = useToolsStore()
    expect(store.fileHistory[0]).toMatchObject({ description: '修改文件「config.json」', moves: [], write: { path: CONFIG, created: false, backupId: 'backup-1', afterHash: 'hash-after' } })
    expect(await store.undoOperation(store.fileHistory[0]!.id)).toBe('已恢复文件原来的内容')
    expect(fs.calls[2]).toEqual({ command: 'undo', args: [[DOWNLOADS, 'C:\\Users\\me\\Desktop'], CONFIG, 'backup-1', 'hash-after'] })
    expect(store.fileHistory[0]!.undone).toBe(true)
  })

  it('用户拒绝或预览出错时不写入文件', async () => {
    const denied = await call('write_file', { path: '桌面/config.json', content: '{}', reason: '新建配置' }, async () => false)
    expect(denied?.toolCalls[0]?.output).toMatchObject({ written: false })

    fs.previewError = '修改的原文没有在文件中找到'
    const requestPermission = vi.fn<(request: PermissionRequest) => Promise<boolean>>(async () => true)
    const failed = await call('edit_file', { path: '桌面/config.json', edits: [{ oldText: 'x', newText: 'y' }], reason: '改端口' }, requestPermission)
    expect(failed?.toolCalls[0]?.error).toContain('没有在文件中找到')
    expect(requestPermission).not.toHaveBeenCalled()

    const empty = await call('edit_file', { path: '桌面/config.json', reason: '改端口' }, requestPermission)
    expect(empty?.toolCalls[0]?.error).toContain('需要提供 edits 或 append')

    expect(fs.calls.map((c) => c.command)).toEqual(['preview', 'preview'])
    expect(useToolsStore().fileHistory).toEqual([])
  })

  it('查找文件时换算修改时间并解析文件夹', async () => {
    const res = await call('search_files', { keywords: ['合同'], modifiedWithinDays: 7, folder: '下载' })
    const request = fs.calls[0]!.args[1] as { folders: string[], modifiedAfter: number }
    expect(request.folders).toEqual([DOWNLOADS])
    expect(Date.now() - request.modifiedAfter).toBeGreaterThan(7 * 24 * 3600_000 - 5000)
    expect(res?.toolCalls[0]?.output).toMatchObject({ count: 1, files: [{ name: '合同.pdf', size: '2.0 KB', type: 'pdf' }] })
  })
})

describe('阅读长文件与查看目录结构', () => {
  const NOTES = 'C:\\Users\\me\\Desktop\\notes.md'
  const outputOf = (res: Awaited<ReturnType<typeof call>>) => res?.toolCalls[0]?.output as { content: string, note?: string }

  it('长文件可以用 offset 接着读取', async () => {
    fs.text = Array.from({ length: 60_000 }, (_, i) => String.fromCharCode(0x4E00 + (i % 100))).join('')

    const first = outputOf(await call('read_file', { path: NOTES }))
    expect(first.content).toHaveLength(24_000)
    expect(first.note).toBe('文件较长，只读取了前 24000 字（共 60000 字），可以用 offset: 24000 接着读取')

    const next = outputOf(await call('read_file', { path: NOTES, offset: 24_000, maxChars: 5000 }))
    // 读出前 offset + maxChars 字再截取
    expect(fs.calls.at(-1)?.args[2]).toBe(29_000)
    expect(next.content).toBe(fs.text.slice(24_000, 29_000))
    expect(next.note).toBe('这是第 24001～29000 字（共 60000 字），后面还有内容，可以用 offset: 29000 接着读取')

    const last = outputOf(await call('read_file', { path: NOTES, offset: 58_000, maxChars: 5000 }))
    expect(last.content).toHaveLength(2000)
    expect(last.note).toBe('这是第 58001～60000 字，已经读到文件末尾（共 60000 字）')

    const beyond = outputOf(await call('read_file', { path: NOTES, offset: 70_000 }))
    expect(beyond).toMatchObject({ content: '', note: '文件一共只有 60000 字，offset 超出了范围' })
  })

  it('按字符计数，不会把表情等字符截成两半', async () => {
    fs.text = '😀'.repeat(10)
    const output = outputOf(await call('read_file', { path: NOTES, offset: 4, maxChars: 500 }))
    expect(output.content).toBe('😀'.repeat(6))
  })

  it('查看多层的目录结构，依赖文件夹只列出不展开，到达层数上限的文件夹标出项数', async () => {
    const PROJECT = 'C:\\Users\\me\\Desktop\\proj'
    const entry = (path: string, isDir: boolean, size = 0): FileEntry => ({ path, name: path.split('\\').pop()!, isDir, size, modifiedAt: 0, extension: '' })
    fs.tree = {
      [PROJECT]: [entry(`${PROJECT}\\node_modules`, true), entry(`${PROJECT}\\src`, true), entry(`${PROJECT}\\package.json`, false, 2048)],
      [`${PROJECT}\\node_modules`]: [entry(`${PROJECT}\\node_modules\\vue`, true)],
      [`${PROJECT}\\src`]: [entry(`${PROJECT}\\src\\agent`, true), entry(`${PROJECT}\\src\\main.ts`, false, 1024)],
      [`${PROJECT}\\src\\agent`]: [entry(`${PROJECT}\\src\\agent\\executor.ts`, false, 12_600)],
    }

    const res = await call('folder_tree', { path: PROJECT, depth: 2 })
    expect(res?.toolCalls[0]?.output).toEqual({
      path: PROJECT,
      tree: [
        'proj/',
        '  node_modules/（依赖或生成的文件，未展开）',
        '  src/',
        '    agent/（1 项，未展开）',
        '    main.ts（1.0 KB）',
        '  package.json（2.0 KB）',
      ].join('\n'),
      folders: 3,
      files: 2,
    })
    // 依赖文件夹不会被读取
    expect(fs.calls.some((c) => c.command === 'list' && c.args[1] === `${PROJECT}\\node_modules`)).toBe(false)
  })
})
