import type { PermissionRequest } from '@/agent/types'
import type { ModelMessage } from 'ai'
import type { FileContent, PdfOutput, PdfOutputPlan, PdfPrintRequest, QualityIssue, RunCodeRequest, ScriptResult, TargetChange, TargetInfo } from '@/files/api'
import type { StoredDocument } from '@/utils/documents'
import { MockLanguageModelV3 } from 'ai/test'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runAgent } from '@/agent'
import { collectTools } from '@/agent/executor'
import { filesSkill } from '@/agent/skills/files'
import { EXTRACT_MODEL_CHARS, formatPages, MAX_AUTO_FIX_ROUNDS, neededExamples, officeSkill, previousChecks, pythonExampleFor } from '@/agent/skills/office'
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
  prints: [] as PdfPrintRequest[],
  composes: [] as PdfOutput[][],
  plans: [] as PdfOutputPlan[],
  planError: null as string | null,
  documents: new Map<string, StoredDocument>(),
  extracted: [] as { name: string, size: number }[],
  extractContent: '',
  quality: new Map<string, QualityIssue[]>(),
  exitCode: 0 as number | null,
}))

vi.mock('@/utils/documents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/documents')>()),
  loadDocument: async (id: string) => api.documents.get(id),
  saveExtracted: async (id: string, extracted: StoredDocument['extracted']) => {
    const document = api.documents.get(id)
    if (document) api.documents.set(id, { ...document, extracted })
  },
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
    return { ...RESULT, exitCode: api.exitCode }
  },
  settleTargets: async () => {
    api.calls.push('settle')
    return api.changes
  },
  printHtmlToPdf: async (_roots: string[], request: PdfPrintRequest) => {
    api.calls.push('print')
    api.prints.push(request)
    return { path: request.path, pages: 2, size: 30_720, browser: 'Microsoft Edge', durationMs: 1200, cancelled: false, timedOut: false }
  },
  planPdfCompose: async () => {
    api.calls.push('plan')
    if (api.planError) throw new Error(api.planError)
    return api.plans
  },
  composePdf: async (_roots: string[], outputs: PdfOutput[]) => {
    api.calls.push('compose')
    api.composes.push(outputs)
    return api.plans.map((plan) => ({ path: plan.path, pages: plan.pages, size: 2048 }))
  },
  checkOfficeFile: async (_roots: string[], path: string) => {
    api.calls.push(`check-quality ${path.split('\\').pop()}`)
    return api.quality.get(path) ?? []
  },
  extractFileText: async (name: string, data: ArrayBuffer): Promise<FileContent> => {
    api.calls.push('extract')
    api.extracted.push({ name, size: data.byteLength })
    const content = api.extractContent
    return { path: '', name, size: data.byteLength, content, truncated: false, totalChars: content.length, format: 'docx', encoding: null }
  },
  readFile: async (_roots: string[], path: string) => {
    api.calls.push(`read ${path.split('\\').pop()}`)
    return { path, name: '', size: 0, content: `「${path.split('\\').pop()}」的内容`, truncated: false, totalChars: 10, format: 'text', encoding: null }
  },
}))

/** 用户提出这个请求时 Office 技能的使用说明 */
function instructionsFor(request: string): string {
  const instructions = officeSkill.instructions
  return typeof instructions === 'function' ? instructions({ messages: [{ role: 'user', content: request }] }) : instructions
}

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
    prints: [],
    composes: [],
    plans: [],
    planError: null,
    documents: new Map(),
    quality: new Map(),
    exitCode: 0,
    extracted: [],
    extractContent: '# 合同\n| 甲方 | 乙方 |\n| --- | --- |\n| A | B |\n\n【批注】\n[批注1] 张三：核对金额',
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
    // 运行后读回内容，并自动检查改动过的 Office 文件（PDF 不检查）
    expect(api.calls).toEqual(['check', 'inspect', 'permission', 'snapshot', 'run', 'settle', 'read 销售.xlsx', 'read 销售.pdf', 'check-quality 销售.xlsx'])
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

  it('按本机的情况说明可用的方式；只附上要处理的文件类型的示例，没有安装 Office 的类型用 Python 示例', () => {
    useToolsStore().officeSupport = { word: true, excel: false, powerpoint: false, pythonLibraries: ['openpyxl'], pdfBrowser: 'Microsoft Edge' }
    const instructions = instructionsFor('做一份会议纪要的 Word 文档，再把销售数据做成 Excel 表格')
    expect(instructions).toContain('Microsoft Office（language 为 powershell，通过 COM 调用）：已安装 Word')
    expect(instructions).toContain('Python 库（language 为 python）：已安装 openpyxl')
    expect(instructions).toContain('## 示例：Word（PowerShell 调用 Microsoft Office）')
    // 示例来自与 Rust 端测试共用的文件
    expect(instructions).toContain('$word.AutomationSecurity = 3')
    // Excel 没有安装：用 Python 示例中 Excel 的部分（带着共用的开头）
    expect(instructions).toContain('## 示例：Excel（Python 库 openpyxl）')
    expect(instructions).toContain('book = Workbook()')
    expect(instructions).toContain("ACCENT, LIGHT, LINE, MUTED = '1F4E79'")
    expect(instructions).not.toContain('doc = Document()')
    expect(instructions).not.toContain('## 示例：PowerPoint')
    expect(instructions).not.toContain('deck = Presentation()')
    expect(instructions).toContain('本机使用 Microsoft Edge 打印。')

    useToolsStore().officeSupport = { word: false, excel: false, powerpoint: false, pythonLibraries: [], pdfBrowser: null }
    const without = instructionsFor('做一个 PPT')
    expect(without).toContain('create_pdf 不可用')
    // 都没有安装时不附示例，说明需要安装
    expect(without).not.toContain('## 示例：')
  })

  it('判断要附上哪些示例：请求要新建或修改的文件类型、追问时最近提到的文件、这次执行中要过或处理过的', () => {
    const kinds = (messages: ModelMessage[]) => [...neededExamples(messages)].sort()
    const user = (content: string): ModelMessage => ({ role: 'user', content })
    expect(kinds([user('帮我做一个介绍产品的 PPT')])).toEqual(['powerpoint'])
    expect(kinds([user('把报告.docx 的标题改成红色，再导出 PDF')])).toEqual(['word'])
    // 只是阅读、总结文件时不需要示例
    expect(kinds([user('总结一下这个文档\n\n【附文件：doc_1｜合同.docx｜2.0 KB】')])).toEqual([])
    // 追问：从最近的消息（包括之前的工具调用记录）中的文件判断
    expect(kinds([user('做一个年度总结'), { role: 'assistant', content: '做好了：C:\\桌面\\年度总结.pptx' }, user('把标题改成红色')])).toEqual(['powerpoint'])
    // 这次执行中：用 office_example 要过的，run_office_script 处理过的
    const toolCall = (toolName: string, input: unknown): ModelMessage => ({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: toolName, toolName, input }] })
    expect(kinds([user('看看'), toolCall('office_example', { types: ['excel'] }), toolCall('run_office_script', { files: ['C:\\a\\b.docx', 'C:\\a\\b.pdf'] })])).toEqual(['excel', 'word'])
  })

  it('没有判断出文件类型时，说明先用 office_example 获取示例；获取后加入使用说明', async () => {
    useToolsStore().officeSupport = { word: true, excel: true, powerpoint: true, pythonLibraries: [], pdfBrowser: 'Microsoft Edge' }
    const instructions = instructionsFor('处理一下这个文件')
    expect(instructions).not.toContain('## 示例：')
    expect(instructions).toContain('先用 office_example 获取要处理的文件类型')

    const res = await runAgent({
      model: new MockLanguageModelV3(),
      messages: [{ role: 'user', content: '处理一下这个文件' }],
      skills: [officeSkill],
      directCall: { skillId: 'office', toolName: 'office_example', input: { types: ['powerpoint'] } },
    })
    expect(res?.toolCalls[0]?.output).toMatchObject({ types: ['powerpoint'], message: 'PowerPoint 的示例已加入使用说明的「示例代码」一节，照着示例写代码' })
    const after = officeSkill.instructions as (context: { messages: ModelMessage[] }) => string
    const withExample = after({ messages: [{ role: 'user', content: '处理一下这个文件' }, { role: 'assistant', content: [{ type: 'tool-call', toolCallId: '1', toolName: 'office_example', input: { types: ['powerpoint'] } }] }] })
    expect(withExample).toContain('## 示例：PowerPoint（PowerShell 调用 Microsoft Office）')
    expect(withExample).toContain('还需要其他文件类型的示例时，用 office_example 获取')
  })

  it('Python 示例按文件类型截取', () => {
    const word = pythonExampleFor(['word'])
    expect(word).toContain('doc = Document()')
    expect(word).not.toContain('book = Workbook()')
    expect(word).not.toContain('deck = Presentation()')
    expect(word.startsWith('# Python：')).toBe(true)
    expect(word.trimEnd().endsWith("print('已保存', folder)")).toBe(true)
    const both = pythonExampleFor(['excel', 'powerpoint'])
    expect(both).toContain('book = Workbook()')
    expect(both).toContain('deck = Presentation()')
    expect(both).not.toContain('doc = Document()')
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

describe('PDF', () => {
  const REPORT = `${DESKTOP}\\周报.pdf`
  const A = `${DESKTOP}\\a.pdf`
  const B = `${DESKTOP}\\b.pdf`

  function pdfCall(toolName: string, input: Record<string, unknown>, requestPermission?: (request: PermissionRequest) => Promise<boolean>) {
    return runAgent({
      model: new MockLanguageModelV3(),
      messages: [{ role: 'user', content: '处理 PDF' }],
      skills: [officeSkill],
      directCall: { skillId: 'office', toolName, input: { reason: '处理 PDF', ...input } },
      requestPermission,
    })
  }

  it('页码的简短写法', () => {
    expect(formatPages([1, 2, 3], 3)).toBe('全部 3 页')
    expect(formatPages([1, 2, 3, 5, 9, 8, 7], 10)).toBe('第 1-3、5、9-7 页（7 页）')
    expect(formatPages([4, 4, 2], 4)).toBe('第 4、4、2 页（3 页）')
    expect(formatPages([3, 2, 1], 3)).toBe('第 3-1 页（3 页）')
  })

  it('create_pdf：展示 HTML 并请求同意，同意后备份、打印、记录改动并读回内容', async () => {
    api.targets = [{ path: REPORT, exists: false, size: 0 }]
    api.changes = [{ path: REPORT, changed: true, created: true, deleted: false, backupId: null, afterHash: 'h', error: null }]
    const requests: PermissionRequest[] = []
    const html = '<h1>周报</h1>'
    const res = await pdfCall('create_pdf', { path: '桌面/周报.pdf', html }, async (request) => {
      requests.push(request)
      api.calls.push('permission')
      return true
    })

    expect(api.calls).toEqual(['check', 'permission', 'snapshot', 'print', 'settle', 'read 周报.pdf'])
    expect(requests[0]).toMatchObject({ kind: 'files-write', title: '生成「周报.pdf」', targetFormat: 'code', allowAlways: false })
    expect(requests[0]!.target).toBe(`新建 ${REPORT}\n\n内容（HTML，共 1 行）：\n${html}`)
    expect(api.prints[0]).toMatchObject({ path: REPORT, html })
    expect(api.prints[0]!.runId).toMatch(/^script-/)
    expect(useToolsStore().fileHistory.map((item) => item.description)).toEqual(['新建「周报.pdf」（PDF）'])
    expect(res?.toolCalls[0]?.output).toMatchObject({ created: true, path: REPORT, pages: 2, size: '30 KB', content: '「周报.pdf」的内容' })
    expect(res?.displays[0]?.title).toBe('生成 PDF：周报.pdf')
  })

  it('create_pdf：只能生成 .pdf；本机没有浏览器时直接报错；用户拒绝时不打印', async () => {
    const requestPermission = vi.fn<(request: PermissionRequest) => Promise<boolean>>(async () => false)
    let res = await pdfCall('create_pdf', { path: '桌面/周报.docx', html: '<p>x</p>' }, requestPermission)
    expect(res?.toolCalls[0]?.error).toContain('必须是 .pdf')

    useToolsStore().officeSupport = { word: true, excel: false, powerpoint: false, pythonLibraries: [], pdfBrowser: null }
    res = await pdfCall('create_pdf', { path: '桌面/周报.pdf', html: '<p>x</p>' }, requestPermission)
    expect(res?.toolCalls[0]?.error).toContain('没有找到 Microsoft Edge')
    expect(requestPermission).not.toHaveBeenCalled()

    useToolsStore().officeSupport = null
    api.targets = [{ path: REPORT, exists: true, size: 1024 }]
    res = await pdfCall('create_pdf', { path: '桌面/周报.pdf', html: '<p>x</p>' }, requestPermission)
    expect(requestPermission.mock.calls[0]![0].title).toBe('覆盖「周报.pdf」')
    expect(res?.toolCalls[0]?.output).toMatchObject({ created: false })
    expect(api.calls).not.toContain('snapshot')
  })

  it('edit_pdf：先检查计划，列出每个文件由哪些页面组成，同意后备份并生成', async () => {
    const MERGED = `${DESKTOP}\\合并.pdf`
    api.plans = [{ path: MERGED, exists: false, pages: 6, parts: [
      { path: A, totalPages: 5, pages: [4, 5, 1], rotate: 0 },
      { path: B, totalPages: 3, pages: [1, 2, 3], rotate: 90 },
    ] }]
    api.changes = [{ path: MERGED, changed: true, created: true, deleted: false, backupId: null, afterHash: 'h', error: null }]
    const requests: PermissionRequest[] = []
    const res = await pdfCall('edit_pdf', { outputs: [{ path: '桌面/合并.pdf', parts: [{ path: '桌面/a.pdf', pages: '4-5,1' }, { path: '桌面/b.pdf', rotate: 90 }] }] }, async (request) => {
      requests.push(request)
      api.calls.push('permission')
      return true
    })

    expect(api.calls).toEqual(['plan', 'check', 'permission', 'snapshot', 'compose', 'settle'])
    // 相对授权文件夹的路径换成完整路径
    expect(api.composes[0]).toEqual([{ path: MERGED, parts: [{ path: A, pages: '4-5,1' }, { path: B, rotate: 90 }] }])
    expect(requests[0]).toMatchObject({ kind: 'files-write', title: '生成「合并.pdf」', targetLabel: '计划' })
    expect(requests[0]!.target).toBe(`新建 ${MERGED}（共 6 页）：\n  a.pdf 第 4-5、1 页（3 页）\n  b.pdf 全部 3 页，顺时针旋转 90°`)
    expect(useToolsStore().fileHistory.map((item) => item.description)).toEqual(['新建「合并.pdf」（PDF）'])
    expect(res?.toolCalls[0]?.output).toMatchObject({ done: true, files: [{ path: MERGED, status: '新建', pages: 6, size: '2.0 KB' }] })
  })

  it('edit_pdf：页码超出范围等问题直接报错，不请求同意', async () => {
    api.planError = '「a.pdf」只有 5 页，没有第 9 页'
    const requestPermission = vi.fn<(request: PermissionRequest) => Promise<boolean>>(async () => true)
    const res = await pdfCall('edit_pdf', { outputs: [{ path: A, parts: [{ path: A, pages: '9' }] }] }, requestPermission)
    expect(res?.toolCalls[0]?.error).toContain('只有 5 页')
    expect(requestPermission).not.toHaveBeenCalled()
  })
})

describe('提取文档内容', () => {
  const withDocument = '翻译一下\n\n【附文件：doc_2｜合同.docx｜2.0 KB】'

  function extract(input: Record<string, unknown>, content = withDocument) {
    return runAgent({
      model: new MockLanguageModelV3(),
      messages: [{ role: 'user', content: '先看看这个\n\n【附文件：doc_1｜旧.docx｜1.0 KB】' }, { role: 'assistant', content: '好的' }, { role: 'user', content }],
      skills: [officeSkill],
      directCall: { skillId: 'office', toolName: 'extract_document', input },
    })
  }

  beforeEach(() => {
    for (const id of ['doc_1', 'doc_2']) {
      api.documents.set(id, { id, name: id === 'doc_1' ? '旧.docx' : '合同.docx', mediaType: '', size: 4, data: new Blob(['data']), createdAt: 0 })
    }
  })

  it('对话中发送的文件：发给 Rust 端提取一次并保存结果，完整的内容以卡片展示', async () => {
    const res = await extract({})
    // 默认处理最近一条消息中的文件
    expect(api.extracted).toEqual([{ name: '合同.docx', size: 4 }])
    expect(res?.displays[0]).toEqual({ title: '文档内容：合同.docx', content: api.extractContent, format: 'text' })
    expect(res?.toolCalls[0]?.output).toMatchObject({ name: '合同.docx', format: 'docx', content: api.extractContent, shownToUser: true })
    expect(api.documents.get('doc_2')?.extracted?.content).toBe(api.extractContent)

    // 再次读取时使用保存的结果；只为了回答问题而读取时不展示卡片
    const again = await extract({ display: false })
    expect(api.extracted).toHaveLength(1)
    expect(again?.displays).toEqual([])
    expect(again?.toolCalls[0]?.output).toMatchObject({ content: api.extractContent })
    expect(again?.toolCalls[0]?.output).not.toHaveProperty('display')

    // 指定更早的文件
    await extract({ documentId: 'doc_1' })
    expect(api.extracted.at(-1)).toEqual({ name: '旧.docx', size: 4 })
  })

  it('内容较长时分段返回，卡片仍然展示完整的内容', async () => {
    api.extractContent = 'x'.repeat(EXTRACT_MODEL_CHARS + 500)
    const res = await extract({})
    const output = res?.toolCalls[0]?.output as Record<string, unknown>
    expect((output.content as string).length).toBe(EXTRACT_MODEL_CHARS)
    expect(output.nextOffset).toBe(EXTRACT_MODEL_CHARS)
    expect(res?.displays[0]?.content.length).toBe(EXTRACT_MODEL_CHARS + 500)

    const next = await extract({ offset: EXTRACT_MODEL_CHARS })
    expect(next?.toolCalls[0]?.output).toMatchObject({ content: 'x'.repeat(500) })
    expect(next?.toolCalls[0]?.output).not.toHaveProperty('nextOffset')
    // 继续读取时不再重复展示卡片
    expect(next?.displays).toEqual([])
  })

  it('授权文件夹中的文件按路径读取；最新的消息没有文件时处理最近一条带文件的消息中的文件', async () => {
    const res = await extract({ path: '桌面/销售.xlsx' }, '读一下销售表')
    expect(api.calls).toEqual(['read 销售.xlsx'])
    expect(res?.toolCalls[0]?.output).toMatchObject({ name: '', path: XLSX, content: '「销售.xlsx」的内容' })

    const earlier = await extract({}, '再读一下')
    expect(earlier?.toolCalls[0]?.output).toMatchObject({ name: '旧.docx' })

    api.documents.clear()
    const missing = await extract({})
    expect(missing?.toolCalls[0]?.error).toContain('找不到文件 doc_2')
  })
})

describe('自动检查生成的演示文稿', () => {
  const PPTX = `${DESKTOP}\\年度总结.pptx`
  const PROBLEMS = ['所有页面没有进入动画：……', '第 2–4 页都是「标题 + 要点」的默认版式：……']

  /** 之前的一次 run_office_script 的结果（在发给模型的消息中） */
  function previousResult(problems: string[]): ModelMessage {
    return {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: `call-${Math.random()}`,
        toolName: 'run_office_script',
        output: { type: 'json', value: { ran: true, ...(problems.length ? { qualityCheck: { issues: [{ path: PPTX, problems }], round: 1, instruction: '' } } : {}) } },
      }],
    }
  }

  function runPptx(history: ModelMessage[] = [], requestPermission: (request: PermissionRequest) => Promise<boolean> = async () => true) {
    return runAgent({
      model: new MockLanguageModelV3(),
      messages: [{ role: 'user', content: '做一个年度总结的 PPT' }, ...history],
      skills: [officeSkill],
      directCall: { skillId: 'office', toolName: 'run_office_script', input: { language: 'powershell', code: CODE, files: ['桌面/年度总结.pptx'], reason: '做 PPT' } },
      requestPermission,
    })
  }

  beforeEach(() => {
    api.targets = [{ path: PPTX, exists: false, size: 0 }]
    api.changes = [{ path: PPTX, changed: true, created: true, deleted: false, backupId: null, afterHash: 'h', error: null }]
    api.quality.set(PPTX, PROBLEMS.map((message) => ({ code: 'x', message })))
  })

  it('发现问题时要求先修正再回复用户，并在结果卡片中列出', async () => {
    const res = await runPptx()
    expect(api.calls).toContain('check-quality 年度总结.pptx')
    const output = res?.toolCalls[0]?.output as { qualityCheck: { issues: unknown, round: number, instruction: string } }
    expect(output.qualityCheck.issues).toEqual([{ path: PPTX, problems: PROBLEMS }])
    expect(output.qualityCheck.round).toBe(1)
    expect(output.qualityCheck.instruction).toContain('请修改代码后再运行一次')
    expect(res?.displays[0]?.content).toContain(`【自动检查】发现以下问题，正在修正\n- 年度总结.pptx：${PROBLEMS[0]}`)
  })

  it('修正时授权卡片说明要修正的问题；问题都修正后不再要求修改', async () => {
    api.quality.set(PPTX, [])
    const requests: PermissionRequest[] = []
    const res = await runPptx([previousResult(PROBLEMS)], async (request) => {
      requests.push(request)
      return true
    })
    expect(requests[0]!.title).toBe('修正「年度总结.pptx」')
    expect(requests[0]!.target).toContain(`自动检查发现的问题：\n  - ${PROBLEMS[0]}\n  - ${PROBLEMS[1]}\n\n文件：`)
    expect(res?.toolCalls[0]?.output).not.toHaveProperty('qualityCheck')
    expect(res?.displays[0]?.content).toContain('【自动检查】之前发现的问题都已修正')
  })

  it(`最多自动修正 ${MAX_AUTO_FIX_ROUNDS} 次，之后如实告诉用户`, async () => {
    const history = Array.from({ length: MAX_AUTO_FIX_ROUNDS }, () => previousResult(PROBLEMS))
    expect(previousChecks(history)).toEqual({ rounds: MAX_AUTO_FIX_ROUNDS, problems: PROBLEMS })
    const res = await runPptx(history)
    const output = res?.toolCalls[0]?.output as { qualityCheck: { round: number, instruction: string } }
    expect(output.qualityCheck.round).toBe(MAX_AUTO_FIX_ROUNDS + 1)
    expect(output.qualityCheck.instruction).toContain('不要再修改')
    expect(res?.displays[0]?.content).toContain(`已经自动修正过 ${MAX_AUTO_FIX_ROUNDS} 次，仍有以下问题`)
  })

  it('用 Python 处理时，不检查 Python 库做不到的（动画、切换效果、页码）', async () => {
    api.quality.set(PPTX, [
      { code: 'no-animation', message: '没有进入动画' },
      { code: 'no-transition', message: '没有切换效果' },
      { code: 'white-background', message: '纯白背景' },
    ])
    const res = await runAgent({
      model: new MockLanguageModelV3(),
      messages: [{ role: 'user', content: '做一个 PPT' }],
      skills: [officeSkill],
      directCall: { skillId: 'office', toolName: 'run_office_script', input: { language: 'python', code: 'print(1)', files: ['桌面/年度总结.pptx'], reason: '做 PPT' } },
      requestPermission: async () => true,
    })
    const output = res?.toolCalls[0]?.output as { qualityCheck: { issues: { problems: string[] }[] } }
    expect(output.qualityCheck.issues[0]!.problems).toEqual(['纯白背景'])
  })

  it('只检查改动过的 Office 文件；脚本运行失败时不检查', async () => {
    // 没有问题的一次运行不算作「发现过问题」
    expect(previousChecks([previousResult([])])).toEqual({ rounds: 0, problems: [] })

    // 改动的是 PDF，不检查；表格要检查
    api.targets = [{ path: XLSX, exists: true, size: 2048 }, { path: PDF, exists: false, size: 0 }]
    api.changes = [
      { path: XLSX, changed: true, created: false, deleted: false, backupId: 'b1', afterHash: 'h1', error: null },
      { path: PDF, changed: true, created: true, deleted: false, backupId: null, afterHash: 'h2', error: null },
    ]
    await call({}, async () => true)
    expect(api.calls.filter((item) => item.startsWith('check-quality'))).toEqual(['check-quality 销售.xlsx'])
    api.changes = [{ path: PPTX, changed: true, created: true, deleted: false, backupId: null, afterHash: 'h', error: null }]

    api.calls = []
    api.exitCode = 1
    await runPptx()
    expect(api.calls.filter((item) => item.startsWith('check-quality'))).toEqual([])
  })
})
