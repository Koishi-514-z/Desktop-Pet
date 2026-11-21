<script setup lang="ts">
import type { ProviderCategory } from '@/stores/providers'
import { ref } from 'vue'
import ProviderAddForm from './ProviderAddForm.vue'
import ProviderDetail from './ProviderDetail.vue'
import ProviderList from './ProviderList.vue'

type ProviderView = 'list' | 'detail' | 'add'

// 当前展示的子视图：导航列表 / 详情设置 / 添加表单
const view = ref<ProviderView>('list')
const selectedProviderId = ref('')
const addCategory = ref<ProviderCategory>('llm')

function showList() {
  view.value = 'list'
}

function showDetail(id: string) {
  selectedProviderId.value = id
  view.value = 'detail'
}

function showAdd(category: ProviderCategory) {
  addCategory.value = category
  view.value = 'add'
}
</script>

<template>
  <ProviderList
    v-if="view === 'list'"
    @select="showDetail"
    @add="showAdd"
  />
  <ProviderDetail
    v-else-if="view === 'detail'"
    :provider-id="selectedProviderId"
    @back="showList"
  />
  <ProviderAddForm
    v-else-if="view === 'add'"
    :category="addCategory"
    @back="showList"
    @created="showDetail"
  />
</template>
