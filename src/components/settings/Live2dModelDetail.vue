<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useLive2dStore, type Live2dMotion } from '@/stores/live2d'

const props = defineProps<{ modelId: string }>()
const emit = defineEmits<{ back: [] }>()

const live2dStore = useLive2dStore()

const model = computed(() => live2dStore.getModelById(props.modelId))
const isCurrent = computed(() => live2dStore.currentModelId === props.modelId)
const canRemove = computed(() => live2dStore.models.length > 1 && !live2dStore.isDefaultModel(props.modelId))

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
const form = ref({
  name: '',
  description: '',
  url: '',
  image: '',
  positionX: 0,
  positionY: 0,
  scale: 1,
  defaultExpressionName: '',
})

watch(model, (m) => {
  if (!m) return
  form.value = {
    name: m.name,
    description: m.description ?? '',
    url: m.url,
    image: m.image,
    positionX: m.position.x,
    positionY: m.position.y,
    scale: m.scale,
    defaultExpressionName: m.defaultExpression.name,
  }
}, { immediate: true, deep: true })

function save() {
  if (!model.value) return

  live2dStore.updateModel(model.value.id, {
    name: form.value.name,
    description: form.value.description,
    url: form.value.url,
    image: form.value.image,
    position: { x: form.value.positionX, y: form.value.positionY },
    scale: form.value.scale,
    defaultExpression: { name: form.value.defaultExpressionName },
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
</script>

<template>
  <div v-if="model" class="model-detail">
    <header class="detail-header">
      <button class="back-button" title="返回" @click="emit('back')">
        ←
      </button>
      <span class="detail-title">{{ model.name }}</span>
      <span class="status-badge" :class="{ valid: isCurrent }">
        {{ isCurrent ? '使用中' : '未选用' }}
      </span>
    </header>

    <div class="field">
      <label>名称</label>
      <input v-model="form.name" type="text" placeholder="模型名称">
    </div>

    <div class="field">
      <label>描述</label>
      <input v-model="form.description" type="text" placeholder="可选">
    </div>

    <div class="field">
      <label>模型文件地址 (model3.json)</label>
      <input v-model="form.url" type="text" placeholder="/assets/live2d/models/.../model.model3.json">
    </div>

    <div class="field">
      <label>缩略图地址</label>
      <div class="field-row">
        <input v-model="form.image" type="text" placeholder="/assets/live2d/models/.../image.png">
        <div class="thumbnail-preview">
          <img v-if="form.image" :src="form.image" alt="预览">
          <span v-else class="card-thumbnail-placeholder">无预览图</span>
        </div>
      </div>
    </div>

    <div class="field-grid">
      <div class="field">
        <label>位置 X</label>
        <input v-model.number="form.positionX" type="number" step="1">
      </div>
      <div class="field">
        <label>位置 Y</label>
        <input v-model.number="form.positionY" type="number" step="1">
      </div>
      <div class="field">
        <label>缩放</label>
        <input v-model.number="form.scale" type="number" min="0" step="0.05">
      </div>
    </div>

    <div class="field">
      <label>默认表情</label>
      <select v-if="model.availableExpressions.length > 0" v-model="form.defaultExpressionName" :class="{ 'select-placeholder': !form.defaultExpressionName }">
        <option value="">
          无
        </option>
        <option v-for="expr in model.availableExpressions" :key="expr.name" :value="expr.name">
          {{ expr.name }}
        </option>
      </select>
      <input v-else v-model="form.defaultExpressionName" type="text" placeholder="表情名称，如 expression3.exp3">
    </div>

    <!-- 动作列表 -->
    <div class="meta-section">
      <span class="meta-section-label">动作 ({{ model.availableMotions.length }})</span>
      <template v-if="motionGroups.size > 0">
        <div v-for="[group, motions] in motionGroups" :key="group" class="motion-group">
          <span class="motion-group-name">{{ group }}</span>
          <div class="meta-tags">
            <span
              v-for="motion in motions"
              :key="`${motion.group}-${motion.index}`"
              class="meta-tag"
              :title="motion.fileName"
            >
              {{ motion.index }}
              <span v-if="motion.tags?.length" class="meta-tag-hint">· {{ motion.tags.join(', ') }}</span>
            </span>
          </div>
        </div>
      </template>
      <span v-else class="meta-empty">暂无数据，加载模型后自动填充</span>
    </div>

    <!-- 表情列表 -->
    <div class="meta-section">
      <span class="meta-section-label">表情 ({{ model.availableExpressions.length }})</span>
      <div v-if="model.availableExpressions.length > 0" class="meta-tags">
        <span
          v-for="expr in model.availableExpressions"
          :key="expr.name"
          class="meta-tag"
          :title="expr.fileName"
        >
          {{ expr.name }}
          <span v-if="expr.tags?.length" class="meta-tag-hint">· {{ expr.tags.join(', ') }}</span>
        </span>
      </div>
      <span v-else class="meta-empty">暂无数据，加载模型后自动填充</span>
    </div>

    <!-- 碰撞区域列表 -->
    <div class="meta-section">
      <span class="meta-section-label">碰撞区域 ({{ model.availableHitAreas.length }})</span>
      <div v-if="model.availableHitAreas.length > 0" class="meta-tags">
        <span
          v-for="area in model.availableHitAreas"
          :key="area.id"
          class="meta-tag"
          :title="area.motion ? `触发动作: ${area.motion}` : ''"
        >
          {{ area.name }}
          <span v-if="area.motion" class="meta-tag-hint">→ {{ area.motion }}</span>
        </span>
      </div>
      <span v-else class="meta-empty">暂无数据，加载模型后自动填充</span>
    </div>

    <div class="detail-actions">
      <button class="action-button" @click="save">
        保存
      </button>
      <button class="action-button" :class="{ active: isCurrent }" @click="setCurrent">
        {{ isCurrent ? '使用中' : '设为当前' }}
      </button>
      <button class="action-button danger" :disabled="!canRemove" @click="remove">
        删除
      </button>
    </div>
  </div>
</template>

<style scoped src="../../css/settings/Live2dSetting.css"></style>

<style scoped>
.meta-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.meta-section-label {
  font-size: 12px;
  color: rgb(255 255 255 / 60%);
}

.meta-empty {
  font-size: 12px;
  color: rgb(255 255 255 / 30%);
}

.motion-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.motion-group-name {
  font-size: 11px;
  color: rgb(255 255 255 / 45%);
}

.meta-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.meta-tag {
  padding: 2px 8px;
  font-size: 11px;
  color: rgb(255 255 255 / 75%);
  background: rgb(255 255 255 / 8%);
  border-radius: 4px;
}

.meta-tag-hint {
  color: rgb(255 255 255 / 40%);
}

.select-placeholder {
  color: rgb(255 255 255 / 35%);
}

.field :deep(select option) {
  color: #1a1a1a;
  background: #fff;
}
</style>
