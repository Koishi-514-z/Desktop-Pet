import type { Ref } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import FloatingDock from '@/components/FloatingDock.vue'
import { useSceneStore } from '@/stores/scene'
import { useTasksStore } from '@/stores/tasks'

// 模拟桌面应用：是否运行在 Tauri 中、轮询到的全局鼠标坐标
const desktop = vi.hoisted(() => ({ tauri: false, cursor: null as Ref<{ x: number, y: number } | null> | null }))

vi.mock('@/composables/desktop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/composables/desktop')>()
  const { ref } = await import('vue')
  const cursor = ref<{ x: number, y: number } | null>(null)
  desktop.cursor = cursor
  return {
    ...actual,
    get isTauri() { return desktop.tauri },
    useDesktopCursor: () => cursor,
  }
})

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) }
}

function mountDock() {
  const wrapper = mount(FloatingDock, { attachTo: document.body })
  const dock = wrapper.get('.floating-dock')
  const isExpanded = () => dock.classes().includes('expanded')
  return { wrapper, dock, isExpanded }
}

describe('右下角的悬浮按钮', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    setActivePinia(createPinia())
    desktop.tauri = false
    desktop.cursor!.value = null
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('浏览器中：鼠标移上去时展开，离开一会儿后才收起，在这之前回来不收起', async () => {
    const { dock, isExpanded } = mountDock()
    expect(isExpanded()).toBe(false)

    await dock.trigger('pointerenter')
    expect(isExpanded()).toBe(true)

    await dock.trigger('pointerleave')
    vi.advanceTimersByTime(399)
    await nextTick()
    expect(isExpanded()).toBe(true)

    await dock.trigger('pointerenter')
    vi.advanceTimersByTime(1000)
    await nextTick()
    expect(isExpanded()).toBe(true)

    await dock.trigger('pointerleave')
    vi.advanceTimersByTime(400)
    await nextTick()
    expect(isExpanded()).toBe(false)
  })

  it('桌面应用中按全局鼠标坐标判断：收起时只有露出的半个悬浮球算，展开后按钮所在的区域都算', async () => {
    desktop.tauri = true
    const { wrapper, isExpanded } = mountDock()
    // 窗口 1024 × 768：悬浮球一半在窗口外，按钮区域贴着右下角
    wrapper.get('.dock-orb').element.getBoundingClientRect = () => rect(1000, 600, 48, 48)
    wrapper.get('.floating-dock').element.getBoundingClientRect = () => rect(940, 564, 84, 192)
    const moveTo = async (x: number, y: number) => {
      desktop.cursor!.value = { x, y }
      await nextTick()
    }

    // 收起时按钮区域的其他地方不算，窗口外的那半个球也不算
    await moveTo(960, 620)
    expect(isExpanded()).toBe(false)
    await moveTo(1030, 620)
    expect(isExpanded()).toBe(false)

    await moveTo(1010, 620)
    expect(isExpanded()).toBe(true)
    // 展开后移到按钮之间的空隙也算悬停
    await moveTo(950, 580)
    vi.advanceTimersByTime(1000)
    await nextTick()
    expect(isExpanded()).toBe(true)

    await moveTo(500, 300)
    vi.advanceTimersByTime(400)
    await nextTick()
    expect(isExpanded()).toBe(false)
  })

  it('三个按钮分别打开、收起待办、设置、对话面板', async () => {
    const { wrapper } = mountDock()
    const scene = useSceneStore()

    await wrapper.get('.dock-button.task').trigger('click')
    expect(scene.taskPanelState.visible).toBe(true)
    expect(wrapper.get('.dock-button.task').text()).toBe('×')

    await wrapper.get('.dock-button.settings').trigger('click')
    expect(scene.settingBoxState.visible).toBe(true)

    await wrapper.get('.dock-button.chat').trigger('click')
    expect(scene.interactiveAreaState.visible).toBe(true)
    await wrapper.get('.dock-button.chat').trigger('click')
    expect(scene.interactiveAreaState.visible).toBe(false)
  })

  it('有未完成的待办时，按钮上显示数量，收起的悬浮球上显示小圆点，有逾期的为红色', async () => {
    const { wrapper } = mountDock()
    expect(wrapper.find('.orb-dot').exists()).toBe(false)

    const tasks = useTasksStore()
    tasks.createTask({ title: '写周报' })
    await nextTick()
    expect(wrapper.get('.dock-button.task .badge').text()).toBe('1')
    expect(wrapper.get('.orb-dot').classes()).not.toContain('alert')

    tasks.createTask({ title: '交作业', due: Date.now() - 60_000, dueHasTime: true })
    await nextTick()
    expect(wrapper.get('.dock-button.task .badge').text()).toBe('2')
    expect(wrapper.get('.orb-dot').classes()).toContain('alert')
  })
})
