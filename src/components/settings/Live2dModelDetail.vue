<script setup lang="ts">
import type { Live2dModelForm } from './Live2dModelFields.vue'
import { computed, ref, watch } from 'vue'
import { useLive2dStore, type Live2dMotion } from '@/stores/live2d'
import Live2dModelFields from './Live2dModelFields.vue'

const props = defineProps<{ modelId: string }>()
const emit = defineEmits<{ back: [] }>()

const live2dStore = useLive2dStore()

const model = computed(() => live2dStore.getModelById(props.modelId))
const isCurrent = computed(() => live2dStore.currentModelId === props.modelId)
const canRemove = computed(
  () => live2dStore.models.length > 1 && !live2dStore.isDefaultModel(props.modelId),
)

// 按动作组聚合，方便分组展示
const motionGroups = computed(() => {
  const map = new Map<string, Live2dMotion[]>()
  for (const motion of model.value?.availableMotions ?? []) {
    if (!map.has(motion.group)) map.set(motion.group, [])
    map.get(motion.group)!.push(motion)
  }
  return map
})

// 本地编辑状态，点击"保存"后才写回 store
const form = ref<Live2dModelForm>({
  name: '',
  description: '',
  url: '',
  image: '',
  positionX: 0,
  positionY: 0,
  scale: 1,
})
const defaultExpressionName = ref('')

function resetForm() {
  const m = model.value
  if (!m) return
  form.value = {
    name: m.name,
    description: m.description ?? '',
    url: m.url,
    image: m.image,
    positionX: m.position.x,
    positionY: m.position.y,
    scale: m.scale,
  }
  defaultExpressionName.value = m.defaultExpression.name
}

// 仅在切换模型时重置表单，避免模型加载后元数据更新时覆盖未保存的修改
watch(() => props.modelId, resetForm, { immediate: true })

const dirty = computed(() => {
  const m = model.value
  if (!m) return false
  const f = form.value
  return (
    f.name !== m.name ||
    f.description !== (m.description ?? '') ||
    f.url !== m.url ||
    f.image !== m.image ||
    f.positionX !== m.position.x ||
    f.positionY !== m.position.y ||
    f.scale !== m.scale ||
    defaultExpressionName.value !== m.defaultExpression.name
  )
})

function save() {
  if (!model.value) return

  live2dStore.updateModel(model.value.id, {
    name: form.value.name,
    description: form.value.description,
    url: form.value.url,
    image: form.value.image,
    position: { x: form.value.positionX, y: form.value.positionY },
    scale: form.value.scale,
    defaultExpression: { name: defaultExpressionName.value },
  })
}

function setCurrent() {
  if (!model.value) return
  live2dStore.switchModel(model.value.id)
}

function remove() {
  if (!model.value) return
  live2dStore.removeModel(model.value.id)
  emit('back')
}

// 点击动作卡片预览播放：仅当正在查看的模型就是桌面上已加载的当前模型时可用
const lastPlayed = ref<{ group: string; index: number } | null>(null)

function previewMotion(motion: Live2dMotion) {
  if (!isCurrent.value) return
  live2dStore.playMotion(motion.group, motion.index)
  lastPlayed.value = { group: motion.group, index: motion.index }
}

function isLastPlayed(motion: Live2dMotion) {
  return lastPlayed.value?.group === motion.group && lastPlayed.value.index === motion.index
}

// 模型资源分页
type ResourceTab = 'expressions' | 'motions' | 'hitAreas'
const activeTab = ref<ResourceTab>('expressions')

const tabs = computed(() => [
  { id: 'expressions' as const, label: '表情', count: model.value?.availableExpressions.length ?? 0 },
  { id: 'motions' as const, label: '动作', count: model.value?.availableMotions.length ?? 0 },
  { id: 'hitAreas' as const, label: '碰撞区域', count: model.value?.availableHitAreas.length ?? 0 },
])
</script>

<template>
  <div v-if="model" class="model-detail">
    <header class="detail-header">
      <button class="back-button" title="返回" @click="emit('back')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
      </button>
      <span class="detail-title">模型详情</span>
    </header>

    <Live2dModelFields v-model="form">
      <template #badge>
        <span class="thumb-badge" :class="{ on: isCurrent }">
          {{ isCurrent ? '使用中' : '未选用' }}
        </span>
      </template>
    </Live2dModelFields>

    <!-- 模型资源 -->
    <section class="resource-panel">
      <div class="resource-tabs" role="tablist">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          role="tab"
          class="resource-tab"
          :class="{ active: activeTab === tab.id }"
          :aria-selected="activeTab === tab.id"
          @click="activeTab = tab.id"
        >
          {{ tab.label }}
          <span class="tab-count">{{ tab.count }}</span>
        </button>
      </div>

      <div class="resource-body">
        <!-- 表情：点击设为默认表情 -->
        <template v-if="activeTab === 'expressions'">
          <template v-if="model.availableExpressions.length > 0">
            <p class="resource-hint">点击表情将其设为默认表情</p>
            <div class="tag-list">
              <button
                type="button"
                class="res-tag selectable"
                :class="{ selected: defaultExpressionName === '' }"
                @click="defaultExpressionName = ''"
              >
                无默认表情
              </button>
              <button
                v-for="expr in model.availableExpressions"
                :key="expr.name"
                type="button"
                class="res-tag selectable"
                :class="{ selected: defaultExpressionName === expr.name }"
                :title="expr.fileName"
                @click="defaultExpressionName = expr.name"
              >
                <svg
                  v-if="defaultExpressionName === expr.name"
                  class="tag-star"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" />
                </svg>
                {{ expr.name }}
                <em v-if="expr.tags?.length">{{ expr.tags.join(', ') }}</em>
              </button>
            </div>
          </template>
          <template v-else>
            <p class="resource-empty">暂无数据，模型加载后自动填充</p>
            <label class="inline-field">
              <span>默认表情</span>
              <input v-model="defaultExpressionName" type="text" placeholder="如 expression3.exp3" />
            </label>
          </template>
        </template>

        <!-- 动作 -->
        <template v-else-if="activeTab === 'motions'">
          <div v-if="motionGroups.size > 0" class="motion-groups">
            <p class="resource-hint">
              {{ isCurrent ? '点击动作即可在桌面上播放预览' : '将此模型设为当前模型后，可点击动作进行预览' }}
            </p>
            <div v-for="[group, motions] in motionGroups" :key="group" class="motion-group">
              <div class="motion-group-head">
                <span class="motion-group-name">{{ group || '默认' }}</span>
                <span class="motion-group-line" />
                <span class="motion-group-count">{{ motions.length }}</span>
              </div>
              <div class="tag-list">
                <button
                  v-for="motion in motions"
                  :key="`${motion.group}-${motion.index}`"
                  type="button"
                  class="res-tag motion-tag"
                  :class="{ playable: isCurrent, played: isLastPlayed(motion) }"
                  :disabled="!isCurrent"
                  :title="isCurrent ? `播放 ${motion.fileName}` : motion.fileName"
                  @click="previewMotion(motion)"
                >
                  <svg v-if="isCurrent" class="tag-play" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M7 4.5v15l12-7.5z" />
                  </svg>
                  #{{ motion.index }}
                  <em v-if="motion.tags?.length">{{ motion.tags.join(', ') }}</em>
                </button>
              </div>
            </div>
          </div>
          <p v-else class="resource-empty">暂无数据，模型加载后自动填充</p>
        </template>

        <!-- 碰撞区域 -->
        <template v-else>
          <ul v-if="model.availableHitAreas.length > 0" class="hit-list">
            <li v-for="area in model.availableHitAreas" :key="area.id" class="hit-item">
              <span class="hit-name">{{ area.name }}</span>
              <span class="hit-arrow">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </span>
              <span class="hit-motion" :class="{ none: !area.motion }">
                {{ area.motion || '未绑定动作' }}
              </span>
            </li>
          </ul>
          <p v-else class="resource-empty">暂无数据，模型加载后自动填充</p>
        </template>
      </div>
    </section>

    <footer class="detail-actions">
      <button class="action-button danger" :disabled="!canRemove" @click="remove">删除</button>
      <span class="spacer" />
      <button class="action-button" :class="{ active: isCurrent }" :disabled="isCurrent" @click="setCurrent">
        {{ isCurrent ? '使用中' : '设为当前' }}
      </button>
      <button class="action-button primary" :disabled="!dirty" @click="save">
        {{ dirty ? '保存修改' : '已保存' }}
      </button>
    </footer>
  </div>
</template>

<style scoped src="../../css/settings/Live2dSetting.css"></style>
