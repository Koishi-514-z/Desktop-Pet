import { describe, expect, it } from 'vitest'
import { layoutRects, searchApps } from '@/utils/apps'

const apps = [
  { name: 'Visual Studio Code', appId: 'Microsoft.VisualStudioCode' },
  { name: '终端', appId: 'Microsoft.WindowsTerminal_8wekyb3d8bbwe!App' },
  { name: 'Windows PowerShell', appId: 'powershell' },
  { name: 'Developer PowerShell for VS', appId: 'devps' },
  { name: 'Google Chrome', appId: 'Chrome' },
  { name: 'Microsoft Edge', appId: 'MSEdge' },
  { name: '记事本', appId: 'notepad' },
  { name: 'MySQL 8.0 Command Line Client', appId: 'mysql' },
]

const names = (query: string) => searchApps(apps, query).map((app) => app.name)

describe('查找已安装的应用', () => {
  it('按名称查找：完全相同、开头相同的排在前面', () => {
    expect(names('Visual Studio Code')[0]).toBe('Visual Studio Code')
    expect(names('powershell')).toEqual(['Windows PowerShell', 'Developer PowerShell for VS'])
    expect(names('不存在的应用')).toEqual([])
    expect(names('  ')).toEqual([])
  })

  it('常见的简称、英文名与类别：VS Code、terminal（中文系统上叫「终端」）、浏览器', () => {
    expect(names('VS Code')[0]).toBe('Visual Studio Code')
    expect(names('vscode')[0]).toBe('Visual Studio Code')
    expect(names('terminal')[0]).toBe('终端')
    expect(names('终端')[0]).toBe('终端')
    expect(names('浏览器').slice(0, 2)).toEqual(['Microsoft Edge', 'Google Chrome'])
    expect(names('notepad')).toEqual(['记事本'])
  })
})

describe('排列窗口', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 }

  it('主窗口在左边 60%，其余在右边从上到下平分', () => {
    expect(layoutRects('main-left', [1, 2, 3], area)).toEqual([
      { id: 1, x: 0, y: 0, width: 1152, height: 1040 },
      { id: 2, x: 1152, y: 0, width: 768, height: 520 },
      { id: 3, x: 1152, y: 520, width: 768, height: 520 },
    ])
    expect(layoutRects('main-right', [1, 2], area)).toEqual([
      { id: 1, x: 768, y: 0, width: 1152, height: 1040 },
      { id: 2, x: 0, y: 0, width: 768, height: 1040 },
    ])
    // 只有一个窗口时铺满
    expect(layoutRects('main-left', [1], area)).toEqual([{ id: 1, ...area }])
  })

  it('平分成列、行，除不尽的像素给最后一个；显示器的工作区可以不从 0 开始', () => {
    expect(layoutRects('columns', [1, 2, 3], { x: 100, y: 50, width: 1000, height: 600 })).toEqual([
      { id: 1, x: 100, y: 50, width: 333, height: 600 },
      { id: 2, x: 433, y: 50, width: 333, height: 600 },
      { id: 3, x: 766, y: 50, width: 334, height: 600 },
    ])
    expect(layoutRects('rows', [1, 2], area).map((rect) => [rect.y, rect.height])).toEqual([[0, 520], [520, 520]])
  })

  it('网格：4 个是田字格，3 个时最后一行的窗口占满整行', () => {
    expect(layoutRects('grid', [1, 2, 3, 4], area).map(({ x, y }) => [x, y])).toEqual([[0, 0], [960, 0], [0, 520], [960, 520]])
    expect(layoutRects('grid', [1, 2, 3], area)[2]).toEqual({ id: 3, x: 0, y: 520, width: 1920, height: 520 })
  })

  it('左半边、右半边、铺满', () => {
    expect(layoutRects('left-half', [1], area)).toEqual([{ id: 1, x: 0, y: 0, width: 960, height: 1040 }])
    expect(layoutRects('right-half', [1], area)).toEqual([{ id: 1, x: 960, y: 0, width: 960, height: 1040 }])
    expect(layoutRects('maximize', [1, 2], area)).toHaveLength(2)
    expect(layoutRects('columns', [], area)).toEqual([])
  })
})
