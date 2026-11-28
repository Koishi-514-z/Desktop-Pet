<script setup lang="ts">
import InteractiveArea from '@/components/InteractiveArea.vue'
import CaptureToolbar from '@/components/CaptureToolbar.vue'
import FloatingDock from '@/components/FloatingDock.vue'
import SettingBox from '@/components/SettingBox.vue'
import Stage from '@/components/Stage.vue'
import SubtitleBar from '@/components/SubtitleBar.vue'
import TaskPanel from '@/components/TaskPanel.vue'
import { onMounted } from 'vue'
import { useProactiveStore } from '@/stores/proactive'
import { useToolsStore } from '@/stores/tools'

onMounted(() => {
  // 第一次运行时授权常用的文件夹（桌面、文档、下载、图片）
  useToolsStore().init()
  // 主动交互：在合适的时机主动说话或做小动作
  useProactiveStore().start()
})
</script>

<template>
  <main data-passthrough>
    <Stage class="stage" />
    <SubtitleBar />
    <InteractiveArea />
    <SettingBox />
    <TaskPanel />
    <!-- 右下角的悬浮按钮：打开 / 收起待办、设置、对话面板 -->
    <FloatingDock />
    <CaptureToolbar />
  </main>
</template>

<style scoped src="../css/HomePage.css"></style>
