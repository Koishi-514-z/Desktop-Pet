<script setup lang="ts">
import { ref } from 'vue'
import PersonaMain from './PersonaMain.vue'
import PersonaDetail from './PersonaDetail.vue'
import PersonaAddForm from './PersonaAddForm.vue'

type PersonaView = 'main' | 'detail' | 'add'

const view = ref<PersonaView>('main')
const selectedPersonaId = ref('')

function showMain() {
  view.value = 'main'
}

function showDetail(id: string) {
  selectedPersonaId.value = id
  view.value = 'detail'
}

function showAdd() {
  view.value = 'add'
}
</script>

<template>
  <PersonaMain
    v-if="view === 'main'"
    @select="showDetail"
    @add="showAdd"
  />
  <PersonaDetail
    v-else-if="view === 'detail'"
    :persona-id="selectedPersonaId"
    @back="showMain"
  />
  <PersonaAddForm
    v-else-if="view === 'add'"
    @back="showMain"
    @created="showDetail"
  />
</template>
