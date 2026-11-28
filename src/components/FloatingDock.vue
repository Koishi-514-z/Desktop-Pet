<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { isTauri, useDesktopCursor } from '@/composables/desktop'
import { useSceneStore } from '@/stores/scene'
import { useTasksStore } from '@/stores/tasks'

/**
 * 右下角的悬浮按钮（待办、设置、对话）。
 *
 * 空闲时三个按钮合成一个悬浮球，收在屏幕右边缘、只露出一半；鼠标移到球上时，球滑出并分开成三个按钮，
 * 鼠标离开按钮所在的区域一会儿后再合起来。收起时只有露出的半个球响应鼠标，不挡住下方应用的点击。
 *
 * 桌面应用中窗口开启鼠标穿透时网页收不到鼠标事件（见 composables/desktop.ts），
 * 所以用轮询到的全局鼠标坐标判断是否悬停；浏览器中用普通的鼠标进出事件
 */

// 鼠标离开后，等多久再合起来（毫秒）：在按钮之间移动、稍微移出一点时不会马上收起
const COLLAPSE_DELAY = 400

const sceneStore = useSceneStore()
const tasksStore = useTasksStore()
const cursor = useDesktopCursor()

const chat = computed(() => sceneStore.interactiveAreaState)
const settings = computed(() => sceneStore.settingBoxState)
const tasks = computed(() => sceneStore.taskPanelState)

const dockRef = ref<HTMLElement>()
const orbRef = ref<HTMLElement>()

// 鼠标是否在悬浮球（收起时）或按钮区域（展开时）上
const hovering = ref(false)
// 用键盘（Tab）把焦点移到按钮上时保持展开；用鼠标点过按钮后焦点虽然还在按钮上，但不算，鼠标移开照常收起
const focused = ref(false)

function onFocusIn(event: FocusEvent) {
  focused.value = (event.target as HTMLElement).matches(':focus-visible')
}
const expanded = ref(false)

let collapseTimer: ReturnType<typeof setTimeout> | undefined

function cancelCollapse() {
  clearTimeout(collapseTimer)
  collapseTimer = undefined
}

watch([hovering, focused], ([hover, focus]) => {
  if (hover || focus) {
    cancelCollapse()
    expanded.value = true
  }
  else if (expanded.value && !collapseTimer) {
    collapseTimer = setTimeout(() => {
      collapseTimer = undefined
      expanded.value = false
    }, COLLAPSE_DELAY)
  }
})

// 点是否落在元素上（只算窗口内的部分：露出一半的悬浮球，另一半在屏幕外）
function contains(element: HTMLElement | undefined, x: number, y: number) {
  if (!element || x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false
  const rect = element.getBoundingClientRect()
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}

if (isTauri) {
  watch(cursor, (position) => {
    if (!position) return
    // 展开时整个按钮区域都算悬停（包括按钮之间的空隙），收起时只有悬浮球
    hovering.value = contains(expanded.value ? dockRef.value : orbRef.value, position.x, position.y)
  })
}

function onPointerEnter() {
  if (!isTauri) hovering.value = true
}

function onPointerLeave() {
  if (!isTauri) hovering.value = false
}

// 点击悬浮球（如触屏上没有悬停）时展开
function expand() {
  cancelCollapse()
  expanded.value = true
}

onBeforeUnmount(cancelCollapse)
</script>

<template>
  <nav
    ref="dockRef"
    class="floating-dock"
    :class="{ expanded }"
    aria-label="悬浮按钮"
    @pointerenter="onPointerEnter"
    @pointerleave="onPointerLeave"
    @focusin="onFocusIn"
    @focusout="focused = false"
  >
    <button
      ref="orbRef"
      class="dock-orb"
      type="button"
      title="待办、设置、对话"
      :tabindex="expanded ? -1 : 0"
      @click="expand"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="5" r="1.6" />
        <circle cx="12" cy="12" r="1.6" />
        <circle cx="12" cy="19" r="1.6" />
      </svg>
      <!-- 收起时也能看到有没有未完成、逾期的待办 -->
      <span v-if="tasksStore.pending.length" class="orb-dot" :class="{ alert: tasksStore.overdueCount > 0 }" />
    </button>

    <button
      class="dock-button task"
      :class="{ alert: tasksStore.overdueCount > 0 }"
      type="button"
      :title="tasks.visible ? '收起待办' : `待办（${tasksStore.pending.length} 项未完成）`"
      @click="tasks.visible = !tasks.visible"
    >
      {{ tasks.visible ? '×' : '☑' }}
      <span v-if="!tasks.visible && tasksStore.pending.length" class="badge">{{ tasksStore.pending.length }}</span>
    </button>

    <button
      class="dock-button settings"
      type="button"
      :title="settings.visible ? '收起设置' : '打开设置'"
      @click="settings.visible = !settings.visible"
    >
      {{ settings.visible ? '×' : '⚙️' }}
    </button>

    <button
      class="dock-button chat"
      type="button"
      :title="chat.visible ? '收起对话' : '打开对话'"
      @click="chat.visible = !chat.visible"
    >
      {{ chat.visible ? '×' : '💬' }}
    </button>
  </nav>
</template>

<style scoped src="../css/FloatingDock.css"></style>
