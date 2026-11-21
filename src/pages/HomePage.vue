<script setup lang="ts">
import InteractiveArea from '@/components/InteractiveArea.vue'
import SettingBox from '@/components/SettingBox.vue'
import Stage from '@/components/Stage.vue'
</script>

<template>
  <main>
    <Stage class="stage" />
    <InteractiveArea />
    <SettingBox />
  </main>
</template>

<style scoped src="../css/HomePage.css"></style>
