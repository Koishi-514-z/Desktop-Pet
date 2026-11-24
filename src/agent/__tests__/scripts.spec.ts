import type { PermissionRequest } from '@/agent/types'
import type { RunCodeRequest, RunScriptRequest, ScriptResult } from '@/files/api'
import { MockLanguageModelV3 } from 'ai/test'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runAgent } from '@/agent'
import { clip, describeResult, scriptsSkill } from '@/agent/skills/scripts'
import { useToolsStore } from '@/stores/tools'

const DESKTOP = 'C:\\Users\\me\\Desktop'
const SCRIPT = `${DESKTOP}\\hi.py`

// 模拟 Rust 端的脚本命令
const api = vi.hoisted(() => ({
  inspectError: null as string | null,
  runs: [] as RunScriptRequest[],
  codeRuns: [] as RunCodeRequest[],
  cancelled: [] as string[],
  /** 运行脚本时调用，可以在这里模拟用户中途停止 */
  onRun: null as (() => void) | null,
  finish: null as ((result: ScriptResult) => void) | null,
}))

const RESULT: ScriptResult = {
  command: `python "${SCRIPT}" "a b"`,
  exitCode: 0,
  stdout: '你好\n',
  stderr: '',
  stdoutTruncated: false,
  stderrTruncated: false,
  timedOut: false,
  cancelled: false,
  durationMs: 1234,
  note: null,
}

vi.mock('@/files/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/files/api')>()),
  filesAvailable: true,
  inspectScript: async (_roots: string[], request: RunScriptRequest) => {
    if (api.inspectError) throw new Error(api.inspectError)
    return {
      path: request.path,
      name: 'hi.py',
      kind: 'Python 脚本',
      command: `python "${request.path}" "a b"`,
      workingDir: DESKTOP,
      timeoutSeconds: request.timeoutSeconds ?? 60,
      preview: 'import sys\nprint("你好")',
      lines: 2,
      previewTruncated: false,
    }
  },
  runScript: (_roots: string[], request: RunScriptRequest) => new Promise<ScriptResult>((resolve) => {
    api.runs.push(request)
    api.finish = resolve
    if (api.onRun) api.onRun()
    else resolve(RESULT)
  }),
  inspectCode: async (_roots: string[], request: RunCodeRequest) => ({
    path: '',
    name: 'Python 代码',
    kind: 'Python 代码',
    command: 'python - --verbose',
    workingDir: request.workingDir ?? DESKTOP,
    timeoutSeconds: request.timeoutSeconds ?? 60,
    preview: request.code,
    lines: request.code.split('\n').length,
    previewTruncated: false,
  }),
  runCode: async (_roots: string[], request: RunCodeRequest) => {
    api.codeRuns.push(request)
    return { ...RESULT, command: 'python - --verbose', stdout: '共 3 个文件\n' }
  },
  cancelScript: async (runId: string) => {
    api.cancelled.push(runId)
    api.finish?.({ ...RESULT, exitCode: null, cancelled: true })
    return true
  },
}))

beforeEach(() => {
  Object.assign(api, { inspectError: null, runs: [], codeRuns: [], cancelled: [], onRun: null, finish: null })
  localStorage.clear()
  setActivePinia(createPinia())
  useToolsStore().fileRoots = [{ name: '桌面', path: DESKTOP }]
})

function call(input: unknown, requestPermission?: (request: PermissionRequest) => Promise<boolean>, abortSignal?: AbortSignal, toolName = 'run_script') {
  return runAgent({
    model: new MockLanguageModelV3(),
    messages: [{ role: 'user', content: '运行一下桌面上的 hi.py' }],
    skills: [scriptsSkill],
    directCall: { skillId: 'scripts', toolName, input },
    requestPermission,
    abortSignal,
  })
}

describe('运行脚本技能', () => {
  it('运行前展示命令与脚本内容并请求同意，同意后运行并记录', async () => {
    const requests: PermissionRequest[] = []
    const res = await call({ path: '桌面/hi.py', args: ['a b'], reason: '测试脚本能否运行' }, async (request) => {
      requests.push(request)
      return true
    })

    expect(requests[0]).toMatchObject({ kind: 'script-run', title: '运行 Python 脚本「hi.py」', allowAlways: false, targetFormat: 'code' })
    expect(requests[0]!.target).toContain(`命令：python "${SCRIPT}" "a b"`)
    expect(requests[0]!.target).toContain('print("你好")')
    expect(api.runs[0]).toMatchObject({ path: SCRIPT, args: ['a b'] })
    expect(api.runs[0]!.runId).toMatch(/^script-/)

    expect(res?.toolCalls[0]?.output).toMatchObject({ ran: true, exitCode: 0, summary: '运行成功（用时 1.2 秒）', stdout: '你好\n' })
    expect(res?.displays[0]).toMatchObject({ title: '运行脚本：hi.py', format: 'code' })
    expect(res?.displays[0]?.content).toContain('【输出】\n你好')
    expect(useToolsStore().scriptHistory[0]).toMatchObject({ name: 'hi.py', args: ['a b'], exitCode: 0 })
  })

  it('用户不同意时不运行', async () => {
    const res = await call({ path: '桌面/hi.py', reason: '测试' }, async () => false)
    expect(api.runs).toEqual([])
    expect(res?.toolCalls[0]?.output).toMatchObject({ ran: false })
    expect(useToolsStore().scriptHistory).toEqual([])
  })

  it('检查不通过时直接报错，不请求同意', async () => {
    api.inspectError = '不能运行 .exe 文件'
    const requestPermission = vi.fn<(request: PermissionRequest) => Promise<boolean>>(async () => true)
    const res = await call({ path: '桌面/app.exe', reason: '测试' }, requestPermission)
    expect(res?.toolCalls[0]?.error).toContain('不能运行 .exe')
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it('用户中途停止对话时结束脚本', async () => {
    const controller = new AbortController()
    api.onRun = () => controller.abort()
    await call({ path: '桌面/hi.py', reason: '测试' }, async () => true, controller.signal).catch(() => {})
    expect(api.cancelled).toEqual([api.runs[0]!.runId])
  })
})

describe('直接运行代码', () => {
  const source = 'import os\nprint(f"共 {len(os.listdir())} 个文件")'

  it('展示完整代码并请求同意，同意后运行，不需要写入文件', async () => {
    const requests: PermissionRequest[] = []
    const input = { language: 'python', code: source, args: ['--verbose'], workingDir: '桌面', reason: '统计桌面上的文件数量' }
    const res = await call(input, async (request) => {
      requests.push(request)
      return true
    }, undefined, 'run_code')

    expect(requests[0]).toMatchObject({ kind: 'script-run', title: '运行一段 Python 代码', targetLabel: '代码', targetFormat: 'code', allowAlways: false })
    expect(requests[0]!.target).toContain(`代码（共 2 行）：\n${source}`)
    expect(requests[0]!.notice).toContain('代码不会保存到你的文件夹')
    expect(api.codeRuns[0]).toMatchObject({ language: 'python', code: source, args: ['--verbose'], workingDir: DESKTOP })
    expect(api.runs).toEqual([])

    expect(res?.toolCalls[0]?.output).toMatchObject({ ran: true, exitCode: 0, stdout: '共 3 个文件\n' })
    expect(res?.displays[0]).toMatchObject({ title: '运行 Python 代码', format: 'code' })
    expect(useToolsStore().scriptHistory[0]).toMatchObject({ name: 'Python 代码', args: ['--verbose'] })
  })

  it('用户不同意时不运行', async () => {
    const res = await call({ language: 'python', code: source, reason: '统计' }, async () => false, undefined, 'run_code')
    expect(api.codeRuns).toEqual([])
    expect(res?.toolCalls[0]?.output).toMatchObject({ ran: false, message: '用户没有同意运行这个代码' })
  })
})

describe('输出整理', () => {
  it('截取长输出，保留开头与结尾', () => {
    expect(clip('abcdef', 2, 2)).toBe('ab\n……（中间省略了 2 字）……\nef')
    expect(clip('abcdef', 0, 2)).toBe('……（前面省略了 4 字）……\nef')
    expect(clip('abc', 2, 2)).toBe('abc')
  })

  it('说明运行结果', () => {
    expect(describeResult({ exitCode: 2, timedOut: false, cancelled: false, durationMs: 500 })).toBe('运行失败，退出码 2（用时 0.5 秒）')
    expect(describeResult({ exitCode: null, timedOut: true, cancelled: false, durationMs: 60000 })).toBe('超时，已被结束（用时 60.0 秒）')
  })
})
