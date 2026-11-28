import type { Skill } from '@/agent/types'
import type { AppWindow, Monitor, WindowAction, WindowLayout } from '@/utils/apps'
import { tool } from 'ai'
import { z } from 'zod'
import { getSkillContext } from '@/agent/context'
import { launchApp, LAYOUT_DESCRIPTIONS, layoutRects, listInstalledApps, listWindows, searchApps, setWindowRects, windowAction } from '@/utils/apps'

export const APPS_SKILL_ID = 'apps'

// 关闭窗口的权限类型：关闭前请求同意，用户选择「始终允许」后不再询问
export const APPS_CLOSE_PERMISSION = 'apps-close-window'

/** 打开应用后最多等多久新窗口出现 */
const LAUNCH_WAIT_MS = 15_000
const LAUNCH_POLL_MS = 400
const TITLE_LENGTH = 80

const LAYOUTS = Object.keys(LAYOUT_DESCRIPTIONS) as [WindowLayout, ...WindowLayout[]]

function describeWindow(window: AppWindow) {
  const states = [window.active && '当前窗口', window.minimized && '已最小化', window.maximized && '已最大化'].filter(Boolean)
  return {
    id: window.id,
    app: window.app,
    title: window.title.length > TITLE_LENGTH ? `${window.title.slice(0, TITLE_LENGTH)}…` : window.title,
    ...(states.length ? { state: states.join('、') } : {}),
    monitor: window.monitor,
  }
}

function describeMonitor(monitor: Monitor) {
  return { index: monitor.index, primary: monitor.primary, width: monitor.width, height: monitor.height }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const appsSkill: Skill = {
  id: APPS_SKILL_ID,
  name: '应用与窗口',
  description: '打开、关闭、切换、最小化、最大化、排列用户电脑上的应用程序窗口（仅 Windows）。例如打开 VS Code、切到浏览器、把两个窗口左右分屏、关掉某个窗口，或者进入某种工作模式（打开一组应用并排列好）。',
  examples: [
    '帮我进入开发模式，打开 VS Code、终端和浏览器，并将窗口排列好',
    '打开记事本',
    '切到微信',
    '把浏览器和 Word 左右分屏',
    '关掉所有资源管理器窗口',
    '只留下 VS Code，其他窗口都最小化',
  ],
  instructions: `- 先用 list_windows 看看已经打开了哪些窗口：要用的应用已经有窗口时直接用它（需要时切换过去），不要重复打开。
- 需要打开新的应用时，先用 find_apps 按名称查找（可以用中文、英文或简称，如「VS Code」「终端」「浏览器」），再用 launch_app 打开找到的应用；launch_app 会等新窗口出现，返回它的 id。只能打开开始菜单中的应用。
- 用户没有指定用哪个浏览器、终端时：优先用已经打开的，否则选查到的第一个常见应用（如 Microsoft Edge、Google Chrome；终端优先「终端」，其次 Windows PowerShell）。
- 排列窗口用 arrange_windows，按用户的意思选布局：
${LAYOUTS.map((layout) => `  - ${layout}：${LAYOUT_DESCRIPTIONS[layout]}`).join('\n')}
  例如「开发模式」打开编辑器、终端和浏览器时，用 main-left 把编辑器放在左边、终端和浏览器在右边上下排列；两个窗口「分屏」用 columns。用户要求只留下这些窗口时，设置 minimizeOthers。
- window_action 用来切换（focus）、最小化、最大化、还原、关闭单个窗口。关闭窗口前会请求用户同意，reason 写明为什么要关；关闭相当于点窗口的关闭按钮，有未保存的内容时应用会自己提示保存。
- 窗口 id 只在窗口还开着时有效，打开、关闭过窗口后需要重新 list_windows。
- 不能强制结束程序，不能操作以管理员身份运行的窗口；做不到的事如实告诉用户。完成后简单说明打开了什么、怎么排列的。`,
  tools: {
    list_windows: tool({
      description: '列出当前打开的应用程序窗口（不含桌宠自己）与显示器。窗口按最近使用的顺序排列',
      inputSchema: z.object({
        query: z.string().optional().describe('只列出应用名或标题中包含这些文字的窗口；省略时列出全部'),
      }),
      execute: async ({ query }) => {
        const { windows, monitors } = await listWindows()
        const q = query?.trim().toLowerCase()
        const matched = q ? windows.filter((window) => `${window.app} ${window.title}`.toLowerCase().includes(q)) : windows
        return { windows: matched.map(describeWindow), monitors: monitors.map(describeMonitor) }
      },
    }),

    find_apps: tool({
      description: '在开始菜单中按名称查找已安装的应用，返回可以用 launch_app 打开的应用 id',
      inputSchema: z.object({
        query: z.string().min(1).describe('应用的名称、简称或类别，如「VS Code」「终端」「浏览器」「微信」'),
      }),
      execute: async ({ query }) => {
        const apps = searchApps(await listInstalledApps(), query)
        return apps.length
          ? { apps }
          : { apps, message: `开始菜单中没有找到「${query}」，可以换个名称（如中文名、英文名或全称）再试` }
      },
    }),

    launch_app: tool({
      description: '打开开始菜单中的应用，并等待它的窗口出现',
      inputSchema: z.object({
        appId: z.string().min(1).describe('find_apps 返回的应用 id'),
        name: z.string().min(1).describe('应用名称，用于显示进度'),
      }),
      execute: async ({ appId, name }, options) => {
        const context = getSkillContext(options)
        const before = new Set((await listWindows()).windows.map((window) => window.id))
        context.setStatus?.(`正在打开「${name}」…`)
        await launchApp(appId)

        // 等新窗口出现：有的应用启动较慢，有的会先显示启动画面
        const deadline = Date.now() + LAUNCH_WAIT_MS
        while (Date.now() < deadline) {
          if (context.abortSignal?.aborted) throw context.abortSignal.reason
          await sleep(LAUNCH_POLL_MS)
          const created = (await listWindows()).windows.filter((window) => !before.has(window.id))
          if (created.length) {
            // 再等一下，让窗口标题更新（如浏览器加载完首页）
            await sleep(LAUNCH_POLL_MS)
            const { windows } = await listWindows()
            return { launched: true, newWindows: windows.filter((window) => !before.has(window.id)).map(describeWindow) }
          }
        }
        return {
          launched: true,
          newWindows: [],
          message: '已经打开，但还没有看到新窗口：应用可能已经在运行（只是切到了已有的窗口）、还在启动，或者在后台运行。可以用 list_windows 再看看',
        }
      },
    }),

    window_action: tool({
      description: '对一个窗口进行操作：切换到前台、最小化、最大化、还原或关闭',
      inputSchema: z.object({
        windowId: z.number().describe('list_windows 返回的窗口 id'),
        action: z.enum(['focus', 'minimize', 'maximize', 'restore', 'close']),
        reason: z.string().optional().describe('关闭窗口时向用户说明为什么要关，一句话'),
      }),
      execute: async ({ windowId, action, reason }, options) => {
        const window = (await listWindows()).windows.find((item) => item.id === windowId)
        if (!window) throw new Error('找不到这个窗口，它可能已经关闭了，请重新 list_windows')
        const name = `${window.title}（${window.app}）`

        if (action === 'close') {
          const context = getSkillContext(options)
          context.setStatus?.('等待你的同意…')
          const allowed = await context.requestPermission?.({
            kind: APPS_CLOSE_PERMISSION,
            title: '关闭窗口',
            reason: reason || '按你的要求关闭这个窗口',
            target: name,
            targetLabel: '窗口',
            notice: '相当于点窗口的关闭按钮，有未保存的内容时应用会提示保存',
          }) ?? false
          if (!allowed) return { done: false, window: name, message: '用户没有同意关闭这个窗口' }
        }

        await windowAction(windowId, action as WindowAction)
        return { done: true, window: name, action }
      },
    }),

    arrange_windows: tool({
      description: '按布局排列几个窗口，铺满一个显示器的工作区（不含任务栏）；排好后这些窗口都会显示在前面，第一个窗口成为当前窗口',
      inputSchema: z.object({
        windowIds: z.array(z.number()).min(1).describe('要排列的窗口 id，按布局中的顺序（main-left、main-right 中第一个是主窗口）'),
        layout: z.enum(LAYOUTS),
        monitor: z.number().optional().describe('放在哪个显示器上（list_windows 返回的 monitors 的 index）；省略时用主显示器'),
        minimizeOthers: z.boolean().optional().describe('是否把其余窗口都最小化（「只留下这些窗口」）'),
      }),
      execute: async ({ windowIds, layout, monitor, minimizeOthers }) => {
        const { windows, monitors } = await listWindows()
        const ids = [...new Set(windowIds)]
        const missing = ids.filter((id) => !windows.some((window) => window.id === id))
        if (missing.length) throw new Error(`找不到窗口 ${missing.join('、')}，它们可能已经关闭了，请重新 list_windows`)
        const area = monitors.find((item) => item.index === monitor) ?? monitors.find((item) => item.primary) ?? monitors[0]
        if (!area) throw new Error('没有找到显示器')

        if (minimizeOthers) {
          for (const window of windows) {
            if (!ids.includes(window.id) && !window.minimized) await windowAction(window.id, 'minimize')
          }
        }
        if (layout === 'maximize') {
          for (const id of ids) await windowAction(id, 'maximize')
        }
        else {
          await setWindowRects(layoutRects(layout, ids, area))
        }
        // 从后往前依次切到前台：这些窗口都显示在其他窗口前面，最后第一个窗口成为当前窗口
        for (const id of [...ids].reverse()) await windowAction(id, 'focus').catch(() => {})

        const arranged = ids.map((id) => windows.find((window) => window.id === id)!).map(describeWindow)
        return { done: true, layout, monitor: area.index, windows: arranged }
      },
    }),
  },
}
