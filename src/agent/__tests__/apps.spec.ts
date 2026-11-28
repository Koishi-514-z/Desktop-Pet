import type { ToolExecutionOptions } from 'ai'
import type { AppWindow, Monitor } from '@/utils/apps'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 系统调用换成模拟的：窗口列表、开始菜单中的应用、窗口操作
const system = vi.hoisted(() => ({
  windows: [] as AppWindow[],
  monitors: [] as Monitor[],
  afterLaunch: [] as AppWindow[],
  calls: [] as string[],
}))

vi.mock('@/utils/apps', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/utils/apps')>(),
  listWindows: vi.fn(async () => ({ windows: system.windows, monitors: system.monitors })),
  listInstalledApps: vi.fn(async () => [{ name: 'Visual Studio Code', appId: 'vscode' }, { name: '终端', appId: 'terminal' }]),
  launchApp: vi.fn(async (appId: string) => {
    system.calls.push(`launch ${appId}`)
    // 过一会儿才出现新窗口
    setTimeout(() => { system.windows = [...system.windows, ...system.afterLaunch] }, 1000)
  }),
  windowAction: vi.fn(async (id: number, action: string) => { system.calls.push(`${action} ${id}`) }),
  setWindowRects: vi.fn(async (rects: { id: number, x: number, width: number }[]) => {
    system.calls.push(...rects.map((rect) => `place ${rect.id} x=${rect.x} w=${rect.width}`))
  }),
}))

import { appsSkill } from '@/agent/skills/apps'

const win = (id: number, app: string, extra: Partial<AppWindow> = {}): AppWindow => ({
  id, app, title: `${app} 窗口`, pid: id, minimized: false, maximized: false, active: false, monitor: 0, x: 0, y: 0, width: 800, height: 600, ...extra,
})

function run<T>(name: keyof typeof appsSkill.tools, input: T, context: Record<string, unknown> = {}) {
  const options = { toolCallId: 'call', messages: [], experimental_context: { model: {}, visionModel: {}, ...context } } as unknown as ToolExecutionOptions
  return appsSkill.tools[name]!.execute!(input as never, options) as Promise<Record<string, unknown>>
}

beforeEach(() => {
  system.windows = [win(1, 'msedge', { active: true }), win(2, 'explorer'), win(3, 'WINWORD', { minimized: true })]
  system.monitors = [{ index: 0, primary: false, x: -1920, y: 0, width: 1920, height: 1040 }, { index: 1, primary: true, x: 0, y: 0, width: 2000, height: 1000 }]
  system.afterLaunch = []
  system.calls = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('应用与窗口', () => {
  it('列出窗口（可以按应用名或标题筛选）与显示器', async () => {
    const result = await run('list_windows', { query: 'EDGE' })
    expect(result.windows).toEqual([{ id: 1, app: 'msedge', title: 'msedge 窗口', state: '当前窗口', monitor: 0 }])
    expect(result.monitors).toHaveLength(2)
  })

  it('按名称查找应用；找不到时提示换个名称', async () => {
    expect((await run('find_apps', { query: 'terminal' })).apps).toEqual([{ name: '终端', appId: 'terminal' }])
    expect((await run('find_apps', { query: '微信' })).message).toContain('没有找到')
  })

  it('打开应用后等新窗口出现，返回新窗口', async () => {
    vi.useFakeTimers()
    system.afterLaunch = [win(9, 'Code')]
    const promise = run('launch_app', { appId: 'vscode', name: 'Visual Studio Code' }, { setStatus: vi.fn() })
    await vi.advanceTimersByTimeAsync(3000)
    const result = await promise
    expect(system.calls).toEqual(['launch vscode'])
    expect(result).toMatchObject({ launched: true, newWindows: [{ id: 9, app: 'Code' }] })
  })

  it('一直没有新窗口时也返回，并说明可能的原因', async () => {
    vi.useFakeTimers()
    const promise = run('launch_app', { appId: 'vscode', name: 'Visual Studio Code' })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await promise).toMatchObject({ newWindows: [], message: expect.stringContaining('还没有看到新窗口') })
  })

  it('关闭窗口前请求同意，不同意时不关；其他操作直接进行', async () => {
    const requestPermission = vi.fn(async () => false)
    expect(await run('window_action', { windowId: 2, action: 'close', reason: '用不到了' }, { requestPermission }))
      .toMatchObject({ done: false })
    expect(requestPermission).toHaveBeenCalledWith(expect.objectContaining({ kind: 'apps-close-window', target: 'explorer 窗口（explorer）', reason: '用不到了' }))
    expect(system.calls).toEqual([])

    requestPermission.mockResolvedValue(true)
    await run('window_action', { windowId: 2, action: 'close' }, { requestPermission })
    await run('window_action', { windowId: 3, action: 'restore' })
    expect(system.calls).toEqual(['close 2', 'restore 3'])
    await expect(run('window_action', { windowId: 42, action: 'focus' })).rejects.toThrow('找不到这个窗口')
  })

  it('排列窗口：默认放在主显示器上，可以把其余窗口最小化，最后第一个窗口在最前面', async () => {
    const result = await run('arrange_windows', { windowIds: [2, 1], layout: 'main-left', minimizeOthers: true })
    expect(result).toMatchObject({ done: true, monitor: 1 })
    expect(system.calls).toEqual([
      // 已经最小化的窗口不用再最小化
      'place 2 x=0 w=1200',
      'place 1 x=1200 w=800',
      'focus 1',
      'focus 2',
    ])
    await expect(run('arrange_windows', { windowIds: [42], layout: 'columns' })).rejects.toThrow('找不到窗口 42')
  })

  it('铺满时逐个最大化', async () => {
    await run('arrange_windows', { windowIds: [1], layout: 'maximize', monitor: 0 })
    expect(system.calls).toEqual(['maximize 1', 'focus 1'])
  })
})
