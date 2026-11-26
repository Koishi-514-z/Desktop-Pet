<script setup lang="ts">
import type { PanelRect, PanelSize, ResizeEdge } from '@/utils/panel-resize'
import { onBeforeUnmount, ref } from 'vue'
import { PANEL_MARGIN, RESIZE_EDGES, resizePanel } from '@/utils/panel-resize'

/**
 * 拖动面板的边、角调整大小的手柄，放在面板外框（定位元素，与面板一样大）的最后。
 * 手柄跨在外框边缘，大部分在外面：面板本身裁掉了溢出的内容，放在面板里会挡住贴边的滚动条。
 * 拖动时通过 resize 给出新的位置与尺寸（由面板保存），双击时 reset（恢复默认尺寸）
 */
const props = defineProps<{ min: PanelSize }>()
const emit = defineEmits<{ resize: [rect: PanelRect], reset: [] }>()

const root = ref<HTMLElement | null>(null)

let active: { edge: ResizeEdge, rect: PanelRect, pointerX: number, pointerY: number } | null = null
// 拖动前页面的光标与文字选择设置，拖完恢复
let savedBodyStyle: { cursor: string, userSelect: string } | null = null

function start(edge: ResizeEdge, event: PointerEvent) {
  const frame = root.value?.parentElement
  if (!frame || event.button !== 0) return
  // 从实际显示的大小开始算（保存的尺寸可能比窗口大，被 CSS 收缩过）
  const { left, top, width, height } = frame.getBoundingClientRect()
  active = { edge, rect: { x: left, y: top, width, height }, pointerX: event.clientX, pointerY: event.clientY }
  // 捕获指针：鼠标移得快、移出手柄时照样跟着调整
  const handle = event.currentTarget as HTMLElement
  handle.setPointerCapture(event.pointerId)
  // 拖动期间整个页面都显示缩放光标，也不会选中文字
  savedBodyStyle = { cursor: document.body.style.cursor, userSelect: document.body.style.userSelect }
  document.body.style.cursor = getComputedStyle(handle).cursor
  document.body.style.userSelect = 'none'
}

function move(event: PointerEvent) {
  if (!active) return
  const { edge, rect, pointerX, pointerY } = active
  const limits = { min: props.min, bounds: { width: window.innerWidth, height: window.innerHeight }, margin: PANEL_MARGIN }
  const next = resizePanel(rect, edge, event.clientX - pointerX, event.clientY - pointerY, limits)
  emit('resize', { x: next.x, y: next.y, width: Math.round(next.width), height: Math.round(next.height) })
}

function stop() {
  active = null
  if (savedBodyStyle) {
    document.body.style.cursor = savedBodyStyle.cursor
    document.body.style.userSelect = savedBodyStyle.userSelect
    savedBodyStyle = null
  }
}

onBeforeUnmount(stop)
</script>

<template>
  <div ref="root" class="resize-handles" aria-hidden="true">
    <span
      v-for="edge in RESIZE_EDGES"
      :key="edge"
      class="resize-handle"
      :class="edge"
      title="拖动调整大小，双击恢复默认尺寸"
      @pointerdown.prevent="start(edge, $event)"
      @pointermove="move"
      @pointerup="stop"
      @pointercancel="stop"
      @lostpointercapture="stop"
      @dblclick="emit('reset')"
    />
  </div>
</template>

<style scoped>
/* 与外框一样大，自身不接收鼠标，只有手柄接收 */
.resize-handles {
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
}

.resize-handle {
  position: absolute;
  touch-action: none;
  pointer-events: auto;
}

.resize-handle.n,
.resize-handle.s {
  right: 18px;
  left: 18px;
  height: 8px;
  cursor: ns-resize;
}

.resize-handle.e,
.resize-handle.w {
  top: 18px;
  bottom: 18px;
  width: 8px;
  cursor: ew-resize;
}

.resize-handle.n {
  top: -6px;
}

.resize-handle.s {
  bottom: -6px;
}

.resize-handle.e {
  right: -6px;
}

.resize-handle.w {
  left: -6px;
}

.resize-handle.ne,
.resize-handle.nw,
.resize-handle.se,
.resize-handle.sw {
  width: 22px;
  height: 22px;
}

.resize-handle.ne {
  top: -6px;
  right: -6px;
  cursor: nesw-resize;
}

.resize-handle.sw {
  bottom: -6px;
  left: -6px;
  cursor: nesw-resize;
}

.resize-handle.nw {
  top: -6px;
  left: -6px;
  cursor: nwse-resize;
}

.resize-handle.se {
  right: -6px;
  bottom: -6px;
  cursor: nwse-resize;
}

/* 右下角的握把：提示可以拖动调整大小（离面板边缘 8px，落在圆角以内） */
.resize-handle.se::after {
  position: absolute;
  right: 14px;
  bottom: 14px;
  width: 8px;
  height: 8px;
  content: '';
  border-right: 2px solid rgb(255 255 255 / 22%);
  border-bottom: 2px solid rgb(255 255 255 / 22%);
  border-bottom-right-radius: 3px;
  transition: border-color 0.2s;
}

.resize-handle.se:hover::after {
  border-color: rgb(255 255 255 / 60%);
}
</style>
