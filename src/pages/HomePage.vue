<script setup lang="ts">
import InteractiveArea from '@/components/InteractiveArea.vue'
import SettingBox from '@/components/SettingBox.vue'
import Stage from '@/components/Stage.vue'
import SubtitleBar from '@/components/SubtitleBar.vue'
</script>

<template>
  <main data-passthrough>
    <Stage class="stage" />
    <SubtitleBar />
    <InteractiveArea />
    <SettingBox />
  </main>
</template>

<style scoped src="../css/HomePage.css"></style>
