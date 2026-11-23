<script setup lang="ts">
import InteractiveArea from '@/components/InteractiveArea.vue'
import CaptureToolbar from '@/components/CaptureToolbar.vue'
import SettingBox from '@/components/SettingBox.vue'
import Stage from '@/components/Stage.vue'
import SubtitleBar from '@/components/SubtitleBar.vue'
import TaskPanel from '@/components/TaskPanel.vue'
import { onMounted } from 'vue'
import { useToolsStore } from '@/stores/tools'

// 第一次运行时授权常用的文件夹（桌面、文档、下载、图片）
onMounted(() => useToolsStore().init())
</script>

<template>
  <main data-passthrough>
    <Stage class="stage" />
    <SubtitleBar />
    <InteractiveArea />
    <SettingBox />
    <TaskPanel />
    <CaptureToolbar />
  </main>
</template>

<style scoped src="../css/HomePage.css"></style>
