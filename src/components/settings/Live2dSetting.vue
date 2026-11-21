<script setup lang="ts">
import { ref } from 'vue'
import Live2dMain from './Live2dMain.vue'
import Live2dModelDetail from './Live2dModelDetail.vue'
import Live2dModelAddForm from './Live2dModelAddForm.vue'

type Live2dView = 'main' | 'detail' | 'add'

// 当前展示的子视图：主设置页 / 单个模型详情 / 添加模型
const view = ref<Live2dView>('main')
const selectedModelId = ref('')

function showMain() {
  view.value = 'main'
}

function showDetail(id: string) {
  selectedModelId.value = id
  view.value = 'detail'
}

function showAdd() {
  view.value = 'add'
}
</script>

<template>
  <Live2dMain
    v-if="view === 'main'"
    @select="showDetail"
    @add="showAdd"
  />
  <Live2dModelDetail
    v-else-if="view === 'detail'"
    :model-id="selectedModelId"
    @back="showMain"
  />
  <Live2dModelAddForm
    v-else-if="view === 'add'"
    @back="showMain"
    @created="showDetail"
  />
</template>
