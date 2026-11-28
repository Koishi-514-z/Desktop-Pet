import { invoke } from '@tauri-apps/api/core'
import { isTauri } from '@/composables/desktop'

/**
 * 应用程序与窗口管理（Rust 端见 src-tauri/src/apps.rs）：调用封装，以及不依赖系统的两部分逻辑——
 * 按名称查找已安装的应用（中英文别名）、在显示器的工作区中计算排列窗口的位置。
 */

/** 一个打开的窗口；位置为看得到的范围（物理像素） */
export interface AppWindow {
  id: number
  title: string
  /** 进程的可执行文件名（不含扩展名），如 Code、chrome、WindowsTerminal */
  app: string
  pid: number
  minimized: boolean
  maximized: boolean
  active: boolean
  monitor: number
  x: number
  y: number
  width: number
  height: number
}

/** 显示器的工作区（不含任务栏） */
export interface Monitor {
  index: number
  primary: boolean
  x: number
  y: number
  width: number
  height: number
}

export interface InstalledApp {
  name: string
  appId: string
}

export type WindowAction = 'focus' | 'minimize' | 'maximize' | 'restore' | 'close'

export interface WindowRect {
  id: number
  x: number
  y: number
  width: number
  height: number
}

function ensureDesktop() {
  if (!isTauri) throw new Error('管理应用与窗口需要在桌面应用中使用')
}

export async function listWindows(): Promise<{ windows: AppWindow[], monitors: Monitor[] }> {
  ensureDesktop()
  return invoke('apps_list_windows')
}

export async function listInstalledApps(): Promise<InstalledApp[]> {
  ensureDesktop()
  return invoke('apps_list_installed')
}

export async function launchApp(appId: string): Promise<void> {
  ensureDesktop()
  await invoke('apps_launch', { appId })
}

export async function windowAction(id: number, action: WindowAction): Promise<void> {
  ensureDesktop()
  await invoke('apps_window_action', { id, action })
}

export async function setWindowRects(rects: WindowRect[]): Promise<void> {
  ensureDesktop()
  await invoke('apps_set_window_rects', { rects })
}

// ===== 查找应用 =====

/**
 * 常见的叫法 → 开始菜单中可能的名称。中文系统上不少应用的名称是中文（如 Windows Terminal 叫「终端」），
 * 用户和模型也常说简称（VS Code）或类别（浏览器）
 */
const APP_ALIASES: [string[], string[]][] = [
  [['vscode', 'vs code', 'code'], ['visual studio code']],
  [['终端', 'terminal', 'windows terminal', '命令行'], ['终端', 'terminal', 'windows powershell', '命令提示符', 'command prompt']],
  [['浏览器', 'browser'], ['microsoft edge', 'google chrome', 'firefox', 'brave', 'opera', 'vivaldi']],
  [['edge'], ['microsoft edge']],
  [['chrome', '谷歌浏览器'], ['google chrome']],
  [['火狐', 'firefox'], ['firefox']],
  [['记事本', 'notepad'], ['记事本', 'notepad']],
  [['计算器', 'calculator'], ['计算器', 'calculator']],
  [['资源管理器', '文件管理器', 'explorer', 'file explorer'], ['文件资源管理器', 'file explorer']],
  [['设置', 'settings'], ['设置', 'settings']],
  [['word'], ['word']],
  [['excel'], ['excel']],
  [['powerpoint', 'ppt'], ['powerpoint']],
  [['微信', 'wechat'], ['微信', 'wechat', 'weixin']],
  [['qq'], ['qq']],
]

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** 一个名称与查询的匹配程度：完全相同 > 开头相同 > 包含；不匹配为 0 */
function score(name: string, query: string): number {
  if (!query) return 0
  if (name === query) return 100
  if (name.startsWith(query)) return 80
  if (name.includes(query)) return 60
  return 0
}

/** 按名称查找已安装的应用，最匹配的在前 */
export function searchApps(apps: InstalledApp[], query: string, limit = 8): InstalledApp[] {
  const q = normalize(query)
  if (!q) return []
  // 别名展开出的候选名称，按在别名表中的顺序略微降低分数（如「浏览器」优先 Edge、Chrome）
  const expanded = APP_ALIASES
    .filter(([aliases]) => aliases.some((alias) => alias === q))
    .flatMap(([, names]) => names)

  const scored = apps.map((app) => {
    const name = normalize(app.name)
    let best = score(name, q)
    expanded.forEach((candidate, index) => {
      best = Math.max(best, score(name, candidate) - 5 - index)
    })
    return { app, best }
  })
  return scored
    .filter(({ best }) => best > 0)
    .sort((a, b) => b.best - a.best || a.app.name.length - b.app.name.length)
    .slice(0, limit)
    .map(({ app }) => app)
}

// ===== 排列窗口 =====

export type WindowLayout =
  | 'maximize'
  | 'left-half'
  | 'right-half'
  | 'columns'
  | 'rows'
  | 'grid'
  | 'main-left'
  | 'main-right'

export const LAYOUT_DESCRIPTIONS: Record<WindowLayout, string> = {
  'maximize': '每个窗口铺满整个屏幕（叠在一起）',
  'left-half': '放在屏幕左半边',
  'right-half': '放在屏幕右半边',
  'columns': '从左到右平分成几列',
  'rows': '从上到下平分成几行',
  'grid': '网格（2 个时左右各一半，4 个时田字格）',
  'main-left': '第一个窗口占左边 60%，其余窗口在右边从上到下平分',
  'main-right': '第一个窗口占右边 60%，其余窗口在左边从上到下平分',
}

/** 把一段长度平分成 count 份（整数像素，余数分给最后一份），返回每份的起点与长度 */
function split(start: number, length: number, count: number): { start: number, length: number }[] {
  const size = Math.floor(length / count)
  return Array.from({ length: count }, (_, index) => ({
    start: start + index * size,
    length: index === count - 1 ? length - index * size : size,
  }))
}

/**
 * 按布局计算每个窗口在显示器工作区中的位置（与 ids 顺序对应）
 */
export function layoutRects(layout: WindowLayout, ids: number[], area: Pick<Monitor, 'x' | 'y' | 'width' | 'height'>, mainRatio = 0.6): WindowRect[] {
  const count = ids.length
  if (count === 0) return []
  const { x, y, width, height } = area
  const rect = (index: number, rx: number, ry: number, rw: number, rh: number): WindowRect => ({ id: ids[index]!, x: rx, y: ry, width: rw, height: rh })

  switch (layout) {
    case 'maximize':
      return ids.map((_, index) => rect(index, x, y, width, height))
    case 'left-half':
    case 'right-half': {
      const half = Math.floor(width / 2)
      const left = layout === 'left-half' ? x : x + half
      const w = layout === 'left-half' ? half : width - half
      return ids.map((_, index) => rect(index, left, y, w, height))
    }
    case 'columns':
      return split(x, width, count).map((column, index) => rect(index, column.start, y, column.length, height))
    case 'rows':
      return split(y, height, count).map((row, index) => rect(index, x, row.start, width, row.length))
    case 'grid': {
      const columns = Math.ceil(Math.sqrt(count))
      const rowCount = Math.ceil(count / columns)
      const rows = split(y, height, rowCount)
      return ids.map((_, index) => {
        const row = Math.floor(index / columns)
        // 最后一行不满时，这一行的窗口平分整行
        const inRow = Math.min(columns, count - row * columns)
        const column = split(x, width, inRow)[index % columns]!
        return rect(index, column.start, rows[row]!.start, column.length, rows[row]!.length)
      })
    }
    case 'main-left':
    case 'main-right': {
      if (count === 1) return [rect(0, x, y, width, height)]
      const mainWidth = Math.round(width * mainRatio)
      const sideWidth = width - mainWidth
      const mainX = layout === 'main-left' ? x : x + sideWidth
      const sideX = layout === 'main-left' ? x + mainWidth : x
      return [
        rect(0, mainX, y, mainWidth, height),
        ...split(y, height, count - 1).map((row, index) => rect(index + 1, sideX, row.start, sideWidth, row.length)),
      ]
    }
  }
}
