import type { PermissionRequest } from '@/agent/types'
import type { RunCodeRequest, ScriptResult, TargetChange, TargetInfo } from '@/files/api'
import { MockLanguageModelV3 } from 'ai/test'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runAgent } from '@/agent'
import { collectTools } from '@/agent/executor'
import { filesSkill } from '@/agent/skills/files'
import { officeSkill } from '@/agent/skills/office'
import { useToolsStore } from '@/stores/tools'

const DESKTOP = 'C:\\Users\\me\\Desktop'
const XLSX = `${DESKTOP}\\销售.xlsx`
const PDF = `${DESKTOP}\\销售.pdf`

// 模拟 Rust 端的命令，按调用顺序记录
const api = vi.hoisted(() => ({
  calls: [] as string[],
  checkError: null as string | null,
  runError: null as string | null,
  targets: [] as TargetInfo[],
  runs: [] as RunCodeRequest[],
  changes: [] as TargetChange[],
}))

const RESULT: ScriptResult = {
  command: 'powershell -EncodedCommand （编码后的代码）',
  exitCode: 0,
  stdout: '已保存\n',
  stderr: '',
  stdoutTruncated: false,
  stderrTruncated: false,
  timedOut: false,
  cancelled: false,
  durationMs: 4200,
  note: null,
}

vi.mock('@/files/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/files/api')>()),
  filesAvailable: true,
  checkTargets: async () => {
    api.calls.push('check')
    if (api.checkError) throw new Error(api.checkError)
    return api.targets
  },
  inspectCode: async (_roots: string[], request: RunCodeRequest) => {
    api.calls.push('inspect')
    return {
      path: '',
      name: 'PowerShell 代码',
      kind: 'PowerShell 代码',
      command: RESULT.command,
      workingDir: request.workingDir ?? DESKTOP,
      timeoutSeconds: request.timeoutSeconds ?? 60,
      preview: request.code,
      lines: request.code.split('\n').length,
      previewTruncated: false,
    }
  },
  snapshotTargets: async (_roots: string[], paths: string[]) => {
    api.calls.push('snapshot')
    return paths.map((path) => ({ path, backupId: path === XLSX ? 'b1' : null, beforeHash: path === XLSX ? 'h0' : null }))
  },
  runCode: async (_roots: string[], request: RunCodeRequest) => {
    api.calls.push('run')
    api.runs.push(request)
    if (api.runError) throw new Error(api.runError)
    return RESULT
  },
  settleTargets: async () => {
    api.calls.push('settle')
    return api.changes
  },
  readFile: async (_roots: string[], path: string) => {
    api.calls.push(`read ${path.split('\\').pop()}`)
    return { path, name: '', size: 0, content: `「${path.split('\\').pop()}」的内容`, truncated: false, totalChars: 10, format: 'text', encoding: null }
  },
}))

const CODE = '$excel = New-Object -ComObject Excel.Application\nWrite-Output "已保存"'

beforeEach(() => {
  Object.assign(api, {
    calls: [],
    checkError: null,
    runError: null,
    targets: [{ path: XLSX, exists: true, size: 2048 }, { path: PDF, exists: false, size: 0 }],
    runs: [],
    changes: [
      { path: XLSX, changed: true, created: false, deleted: false, backupId: 'b1', afterHash: 'h1', error: null },
      { path: PDF, changed: true, created: true, deleted: false, backupId: null, afterHash: 'h2', error: null },
    ],
  })
  localStorage.clear()
  setActivePinia(createPinia())
  useToolsStore().fileRoots = [{ name: '桌面', path: DESKTOP }]
})

function call(input: Record<string, unknown>, requestPermission?: (request: PermissionRequest) => Promise<boolean>) {
  return runAgent({
    model: new MockLanguageModelV3(),
    messages: [{ role: 'user', content: '把销售表的表头加粗，再导出 PDF' }],
    skills: [officeSkill],
    directCall: { skillId: 'office', toolName: 'run_office_script', input: { language: 'powershell', code: CODE, files: ['桌面/销售.xlsx', '桌面/销售.pdf'], reason: '加粗表头并导出 PDF', ...input } },
    requestPermission,
  })
}

describe('Office 文档技能', () => {
  it('展示文件与代码并请求同意，同意后备份、运行，记录改动并读回文件内容', async () => {
    const requests: PermissionRequest[] = []
    const res = await call({}, async (request) => {
      requests.push(request)
      api.calls.push('permission')
      return true
    })

    // 同意之后才备份；运行后无论成功与否都对比文件
    expect(api.calls).toEqual(['check', 'inspect', 'permission', 'snapshot', 'run', 'settle', 'read 销售.xlsx', 'read 销售.pdf'])
    expect(requests[0]).toMatchObject({ kind: 'script-run', title: '处理 2 个文件', targetLabel: '改动', targetFormat: 'code', allowAlways: false })
    expect(requests[0]!.target).toContain(`修改 ${XLSX}（2.0 KB，运行前会备份）\n  新建 ${PDF}`)
    expect(requests[0]!.target).toContain('方式：通过 PowerShell 调用 Microsoft Office')
    expect(requests[0]!.target).toContain(CODE)
    expect(api.runs[0]).toMatchObject({ language: 'powershell', code: CODE, workingDir: DESKTOP, timeoutSeconds: 180, cleanupOffice: true })

    const history = useToolsStore().fileHistory
    expect(history.map((item) => item.description)).toEqual(['新建「销售.pdf」（Office 文档）', '已修改「销售.xlsx」（Office 文档）'])
    expect(history[1]!.write).toEqual({ path: XLSX, created: false, deleted: false, backupId: 'b1', afterHash: 'h1' })

    expect(res?.toolCalls[0]?.output).toMatchObject({
      ran: true,
      exitCode: 0,
      files: [
        { path: XLSX, status: '已修改', content: '「销售.xlsx」的内容' },
        { path: PDF, status: '新建', content: '「销售.pdf」的内容' },
      ],
    })
    expect(res?.displays[0]?.title).toBe('Office 文档：改动了 2 个文件')
  })

  it('用户拒绝时不备份也不运行', async () => {
    const res = await call({}, async () => false)
    expect(api.calls).toEqual(['check', 'inspect'])
    expect(res?.toolCalls[0]?.output).toMatchObject({ ran: false })
  })

  it('文件正被其他程序打开时直接报错，不请求同意', async () => {
    api.checkError = '「销售.xlsx」正在被其他程序使用（可能在 Office 中打开着），请先关闭它再试'
    const requestPermission = vi.fn<(request: PermissionRequest) => Promise<boolean>>(async () => true)
    const res = await call({}, requestPermission)
    expect(res?.toolCalls[0]?.error).toContain('正在被其他程序使用')
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it('运行出错时仍然记录已经改动的文件，以便撤销', async () => {
    api.runError = '无法启动脚本'
    api.changes = [{ path: XLSX, changed: true, created: false, deleted: false, backupId: 'b1', afterHash: 'h1', error: null }]
    const res = await call({}, async () => true)
    expect(res?.toolCalls[0]?.error).toContain('无法启动脚本')
    expect(api.calls).toContain('settle')
    expect(useToolsStore().fileHistory).toHaveLength(1)
  })

  it('用 Python 时不需要清理 Office 进程', async () => {
    await call({ language: 'python', code: 'print(1)' }, async () => true)
    expect(api.runs[0]).toMatchObject({ language: 'python', cleanupOffice: false })
  })

  it('按本机的情况说明可用的方式，只展示能用的示例', () => {
    useToolsStore().officeSupport = { word: true, excel: false, powerpoint: false, pythonLibraries: ['openpyxl'] }
    const instructions = typeof officeSkill.instructions === 'function' ? officeSkill.instructions() : officeSkill.instructions
    expect(instructions).toContain('Microsoft Office（language 为 powershell，通过 COM 调用）：已安装 Word')
    expect(instructions).toContain('Python 库（language 为 python）：已安装 openpyxl')
    expect(instructions).toContain('## 示例：Word（PowerShell 调用 Microsoft Office）')
    expect(instructions).toContain('## 示例：Python 库')
    expect(instructions).not.toContain('## 示例：Excel')
    // 示例来自与 Rust 端测试共用的文件
    expect(instructions).toContain('$word.AutomationSecurity = 3')
  })

  it('与「本地文件」技能共用 read_file，同时使用两个技能时不重复', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tools = collectTools([filesSkill, officeSkill])
    expect(tools.read_file).toBe(filesSkill.tools.read_file)
    expect(tools.run_office_script).toBe(officeSkill.tools.run_office_script)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
