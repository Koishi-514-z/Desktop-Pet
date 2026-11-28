<script setup lang="ts">
import type { Live2dModelForm } from './Live2dModelFields.vue'
import type { TagEditorItem } from './Live2dTagEditor.vue'
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { autoTagExpressions } from '@/live2d/auto-tag'
import { readModelResources } from '@/live2d/model-file'
import { expressionTags, hasCustomExpressionTags, hasCustomMotionTags, motionKey, motionTags } from '@/live2d/tags'
import { useAgentStore } from '@/stores/agent'
import { useLive2dStore, type Live2dMotion } from '@/stores/live2d'
import { useProvidersStore } from '@/stores/providers'
import { resolveLanguageModel } from '@/utils/llm'
import Live2dModelFields from './Live2dModelFields.vue'
import Live2dTagEditor from './Live2dTagEditor.vue'

const props = defineProps<{ modelId: string }>()
const emit = defineEmits<{ back: [] }>()

const live2dStore = useLive2dStore()
const agentStore = useAgentStore()
const providersStore = useProvidersStore()

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
const persistentNames = ref<string[]>([])

function togglePersistent(name: string) {
  const index = persistentNames.value.indexOf(name)
  if (index === -1) persistentNames.value.push(name)
  else persistentNames.value.splice(index, 1)
}

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
  persistentNames.value = [...(m.persistentExpressions ?? [])]
}

// 常驻表情只关心选了哪些，与顺序无关
const persistentDirty = computed(() => {
  const saved = model.value?.persistentExpressions ?? []
  return saved.length !== persistentNames.value.length
    || persistentNames.value.some((name) => !saved.includes(name))
})

// 仅在切换模型时重置表单，避免模型加载后元数据更新时覆盖未保存的修改
watch(() => props.modelId, resetForm, { immediate: true })

// 在桌面上拖拽、滚轮缩放模型时，store 中的位置与缩放会立即改变（并已保存），同步到表单。
// 否则表单仍显示旧值，并被当成未保存的修改，此时点击「保存」还会把模型挪回原处
watch(
  [() => model.value?.position.x, () => model.value?.position.y],
  ([x, y]) => {
    if (x === undefined || y === undefined) return
    form.value.positionX = x
    form.value.positionY = y
  },
)
watch(
  () => model.value?.scale,
  (scale) => {
    if (scale !== undefined) form.value.scale = scale
  },
)

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
    defaultExpressionName.value !== m.defaultExpression.name ||
    persistentDirty.value
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
    persistentExpressions: [...persistentNames.value],
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

// ===== 读取模型资源 =====

// 还没有显示过的模型（如刚导入的）没有表情、动作列表：直接读取模型文件，不用先设为当前模型也能打标签
const resourceError = ref('')

async function ensureResources() {
  const m = model.value
  resourceError.value = ''
  if (!m || m.availableExpressions.length > 0 || m.availableMotions.length > 0) return
  try {
    const resources = await readModelResources(m.url)
    // 读取期间可能已经切到了别的模型，或者模型已经显示到桌面上、列表已经填好
    const current = live2dStore.getModelById(m.id)
    if (!current || current.availableExpressions.length > 0 || current.availableMotions.length > 0) return
    live2dStore.updateModel(m.id, {
      availableExpressions: resources.expressions,
      availableMotions: resources.motions,
      availableHitAreas: resources.hitAreas,
    })
  }
  catch (error) {
    resourceError.value = error instanceof Error ? error.message : String(error)
  }
}

watch(() => props.modelId, ensureResources, { immediate: true })

// ===== 情绪标签 =====

// 常驻表情（去水印、眼镜等开关）不参与情绪，不列出
const tagExpressions = computed(() => {
  const persistent = model.value?.persistentExpressions ?? []
  return (model.value?.availableExpressions ?? []).filter((expression) => !persistent.includes(expression.name))
})

const expressionItems = computed<TagEditorItem[]>(() => tagExpressions.value.map((expression) => ({
  key: expression.name,
  label: expression.name,
  title: expression.fileName,
  tags: expressionTags(model.value, expression),
  custom: hasCustomExpressionTags(model.value, expression.name),
})))

function motionItems(motions: Live2dMotion[]): TagEditorItem[] {
  return motions.map((motion) => ({
    key: motionKey(motion),
    label: `#${motion.index}`,
    title: motion.fileName,
    tags: motionTags(model.value, motion),
    custom: hasCustomMotionTags(model.value, motion),
  }))
}

const hasCustomExpressions = computed(() => Object.keys(model.value?.customTags?.expressions ?? {}).length > 0)
const hasCustomMotions = computed(() => Object.keys(model.value?.customTags?.motions ?? {}).length > 0)

function updateExpressionTags(name: string, tags: string[] | null) {
  if (model.value) live2dStore.setExpressionTags(model.value.id, name, tags)
}

function findMotion(key: string) {
  return model.value?.availableMotions.find((motion) => motionKey(motion) === key)
}

function updateMotionTags(key: string, tags: string[] | null) {
  const motion = findMotion(key)
  if (model.value && motion) live2dStore.setMotionTags(model.value.id, motion, tags)
}

// 预览：仅当正在查看的模型就是桌面上的当前模型时可用
function previewExpression(name: string) {
  if (isCurrent.value) live2dStore.playExpression(name)
}

function previewMotion(key: string) {
  const motion = findMotion(key)
  if (isCurrent.value && motion) live2dStore.playMotion(motion.group, motion.index)
}

// ===== 自动打标签：把每个表情渲染成图片，交给视觉模型判断 =====

const autoTag = reactive({ running: false, status: '', result: '', error: '' })
let autoTagController: AbortController | null = null

// 图片理解技能使用的模型；没有单独设置时用对话模型（与 Agent 相同）
function resolveVisionModel() {
  const vision = agentStore.resolveVisionModel()
  if (vision) return vision
  const provider = providersStore.getCurrentLLMProvider()
  return provider ? resolveLanguageModel(provider) : undefined
}

async function runAutoTag() {
  const m = model.value
  if (!m || autoTag.running) return
  const names = tagExpressions.value.map((expression) => expression.name)
  if (names.length === 0) return
  const visionModel = resolveVisionModel()
  if (!visionModel) {
    autoTag.error = '没有可用的模型：请先在 Provider 中配置对话模型，或在 Skills 中为图片理解选择一个能看图的模型'
    return
  }

  autoTagController = new AbortController()
  Object.assign(autoTag, { running: true, status: '正在加载模型…', result: '', error: '' })
  // 进行中切换到别的模型时，结果不显示在新模型的页面上（标签照样只保存到原来的模型）
  const stillHere = () => props.modelId === m.id
  try {
    const result = await autoTagExpressions({
      url: m.url,
      names,
      model: visionModel,
      signal: autoTagController.signal,
      // 桌面上正在显示同一个模型时，贴图是共用的，不能销毁
      keepTextures: () => live2dStore.currentModel?.url === m.url,
      onProgress: (progress) => {
        autoTag.status = progress.phase === 'render'
          ? `正在渲染表情 ${progress.done}/${progress.total}…`
          : `正在识别表情 ${progress.done}/${progress.total}…`
      },
    })
    for (const [name, tags] of Object.entries(result.tags)) live2dStore.setExpressionTags(m.id, name, tags)

    const tagged = Object.values(result.tags).filter((tags) => tags.length > 0).length
    const parts = [`${tagged} 个表情打上了标签`]
    const none = Object.keys(result.tags).length - tagged
    if (none) parts.push(`${none} 个看不出情绪（其中 ${result.unchanged.length} 个和平时看不出区别）`)
    if (result.failed.length) parts.push(`${result.failed.length} 个识别失败（${result.failed[0]!.error}）`)
    if (!stillHere()) return
    autoTag.result = `完成：${parts.join('，')}`
    if (result.failed.length && !tagged) autoTag.error = '识别全部失败：如果模型不支持图片输入，请在 Skills 中为图片理解选择一个能看图的模型'
  }
  catch (error) {
    if (!stillHere()) return
    if (autoTagController?.signal.aborted) autoTag.result = '已取消，没有修改标签'
    else autoTag.error = `自动打标签失败：${error instanceof Error ? error.message : String(error)}`
  }
  finally {
    autoTag.running = false
    autoTag.status = ''
    autoTagController = null
  }
}

function cancelAutoTag() {
  autoTagController?.abort()
}

// 切换到别的模型、离开页面时取消
watch(() => props.modelId, () => {
  cancelAutoTag()
  Object.assign(autoTag, { result: '', error: '' })
})
onBeforeUnmount(cancelAutoTag)

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
            <div class="motion-group-head">
              <span class="motion-group-name">默认表情</span>
              <span class="motion-group-line" />
            </div>
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

            <!-- 常驻表情：可多选，一直叠加在模型上 -->
            <div class="motion-group-head">
              <span class="motion-group-name">常驻表情</span>
              <span class="motion-group-line" />
              <span class="motion-group-count">{{ persistentNames.length }}</span>
            </div>
            <p class="resource-hint">
              选中的表情会一直叠加在模型上，不会被其他表情替换，适合去水印、眼镜、外套这类开关（可多选）
            </p>
            <div class="tag-list">
              <button
                v-for="expr in model.availableExpressions"
                :key="expr.name"
                type="button"
                class="res-tag selectable"
                :class="{ selected: persistentNames.includes(expr.name) }"
                :title="expr.fileName"
                @click="togglePersistent(expr.name)"
              >
                <svg
                  v-if="persistentNames.includes(expr.name)"
                  class="tag-check"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path d="M5 12.5l4.5 4.5L19 7.5" />
                </svg>
                {{ expr.name }}
              </button>
            </div>

            <!-- 情绪标签：说到对应的情绪时换成这个表情 -->
            <div class="motion-group-head">
              <span class="motion-group-name">情绪标签</span>
              <span class="motion-group-line" />
              <button
                v-if="hasCustomExpressions"
                type="button"
                class="text-button"
                :disabled="autoTag.running"
                @click="live2dStore.clearCustomTags(model.id, 'expressions')"
              >
                全部恢复为模型文件中的
              </button>
            </div>
            <p class="resource-hint">
              桌宠说到某种情绪（如 [happy]）时，会随机换成带有这个标签的表情（常驻表情除外）。可以手动编辑，
              也可以让能看图的模型看着每个表情自动判断，会覆盖已有的表情标签，可以随时恢复{{ isCurrent ? '；点 ▶ 在桌面上预览' : '' }}。修改立即生效
            </p>
            <div class="auto-tag">
              <button v-if="!autoTag.running" type="button" class="action-button" :disabled="tagExpressions.length === 0" @click="runAutoTag">
                自动打标签
              </button>
              <button v-else type="button" class="action-button" @click="cancelAutoTag">取消</button>
              <span v-if="autoTag.running" class="auto-tag-status">{{ autoTag.status }}</span>
              <span v-else-if="autoTag.error" class="auto-tag-status warn">{{ autoTag.error }}</span>
              <span v-else-if="autoTag.result" class="auto-tag-status ok">{{ autoTag.result }}</span>
            </div>
            <Live2dTagEditor
              :items="expressionItems"
              :playable="isCurrent"
              @update="updateExpressionTags"
              @play="previewExpression"
            />
          </template>
          <template v-else>
            <p class="resource-empty">{{ resourceError ? `读取模型文件失败：${resourceError}` : '暂无数据，模型加载后自动填充' }}</p>
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
              桌宠说到某种情绪时，也会随机做一个带有这个标签的动作（动作需要手动打标签）。修改立即生效。
              {{ isCurrent ? '点 ▶ 在桌面上预览' : '把这个模型设为当前模型后，可以点 ▶ 在桌面上预览' }}
            </p>
            <div v-if="hasCustomMotions" class="auto-tag">
              <button type="button" class="text-button" @click="live2dStore.clearCustomTags(model.id, 'motions')">
                全部恢复为模型文件中的标签
              </button>
            </div>
            <div v-for="[group, motions] in motionGroups" :key="group" class="motion-group">
              <div class="motion-group-head">
                <span class="motion-group-name">{{ group || '默认' }}</span>
                <span class="motion-group-line" />
                <span class="motion-group-count">{{ motions.length }}</span>
              </div>
              <Live2dTagEditor
                :items="motionItems(motions)"
                :playable="isCurrent"
                @update="updateMotionTags"
                @play="previewMotion"
              />
            </div>
          </div>
          <p v-else class="resource-empty">{{ resourceError ? `读取模型文件失败：${resourceError}` : '暂无数据，模型加载后自动填充' }}</p>
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
