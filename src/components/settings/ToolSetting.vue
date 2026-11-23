<script setup lang="ts">
import type { NamedFolder } from '@/files/api'
import type { FileOperation } from '@/stores/tools'
import { computed, onMounted, ref } from 'vue'
import { formatDate } from '@/agent/utils'
import { filesAvailable, getDefaultRoots } from '@/files/api'
import { useToolsStore } from '@/stores/tools'
import { SEARCH_PROVIDERS, webSearch } from '@/web/search'

const toolsStore = useToolsStore()

// ===== 网页搜索 =====

const provider = computed(() => SEARCH_PROVIDERS.find((item) => item.id === toolsStore.search.provider))
const testing = ref(false)
const testResult = ref('')
const testError = ref('')

async function testSearch() {
  testing.value = true
  testResult.value = ''
  testError.value = ''
  try {
    const response = await webSearch('Tauri 2 desktop app', toolsStore.search, { limit: 3 })
    testResult.value = response.results.length
      ? `连接成功，搜索到 ${response.results.length} 条结果：${response.results[0]!.title}`
      : '连接成功，但没有搜索到结果'
  }
  catch (error) {
    testError.value = error instanceof Error ? error.message : String(error)
  }
  finally {
    testing.value = false
  }
}

// ===== 文件访问 =====

const defaults = ref<NamedFolder[]>([])
const newPath = ref('')
const rootError = ref('')

// 还没有授权的常用文件夹
const suggestions = computed(() => defaults.value.filter((folder) => !toolsStore.fileRoots.some((root) => root.path === folder.path)))

async function addRoot(path: string, name?: string) {
  rootError.value = ''
  try {
    await toolsStore.addRoot(path, name)
    newPath.value = ''
  }
  catch (error) {
    rootError.value = error instanceof Error ? error.message : String(error)
  }
}

// ===== 文件操作记录 =====

const undoMessage = ref('')

function formatTime(timestamp: number) {
  const date = new Date(timestamp)
  return `${formatDate(date)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

// 移动操作显示文件数量；写入操作的标题已经包含文件名，这里显示完整路径
function describeOperation(operation: FileOperation) {
  return operation.write ? operation.write.path : `移动了 ${operation.moves.length} 个文件`
}

async function undo(operation: FileOperation) {
  undoMessage.value = ''
  try {
    undoMessage.value = await toolsStore.undoOperation(operation.id)
  }
  catch (error) {
    undoMessage.value = error instanceof Error ? error.message : String(error)
  }
}

onMounted(async () => {
  if (!filesAvailable) return
  await toolsStore.init()
  defaults.value = await getDefaultRoots().catch(() => [])
})
</script>

<template>
  <div class="scene-setting">
    <section class="tile">
      <header class="tile-head">
        <span class="tile-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5M8 11h6M11 8v6" />
          </svg>
        </span>
        <span class="tile-title">网页搜索</span>
      </header>

      <div class="setting">
        <div class="setting-label">
          <span>搜索服务</span>
          <span class="setting-desc">「网页搜索」技能通过它搜索互联网，再读取网页原文回答问题</span>
        </div>
        <select v-model="toolsStore.search.provider" class="field">
          <option value="none">不使用</option>
          <option v-for="item in SEARCH_PROVIDERS" :key="item.id" :value="item.id">{{ item.name }}</option>
        </select>
        <span v-if="provider" class="setting-desc">{{ provider.description }}</span>
      </div>

      <div v-if="toolsStore.search.provider === 'tavily'" class="setting">
        <span class="setting-label">Tavily API Key</span>
        <input v-model.trim="toolsStore.search.tavilyKey" class="field" type="password" placeholder="tvly-..." autocomplete="off" />
      </div>
      <div v-else-if="toolsStore.search.provider === 'brave'" class="setting">
        <span class="setting-label">Brave Search API Key</span>
        <input v-model.trim="toolsStore.search.braveKey" class="field" type="password" placeholder="BSA..." autocomplete="off" />
      </div>
      <div v-else-if="toolsStore.search.provider === 'searxng'" class="setting">
        <span class="setting-label">SearXNG 地址</span>
        <input v-model.trim="toolsStore.search.searxngUrl" class="field" placeholder="http://localhost:8080" />
      </div>

      <div v-if="toolsStore.search.provider !== 'none'" class="row">
        <button class="reset-button" type="button" :disabled="testing" @click="testSearch">{{ testing ? '测试中…' : '测试连接' }}</button>
        <span v-if="testResult" class="setting-desc ok">{{ testResult }}</span>
        <span v-if="testError" class="setting-desc warn">{{ testError }}</span>
      </div>
    </section>

    <section class="tile">
      <header class="tile-head">
        <span class="tile-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
        </span>
        <span class="tile-title">文件访问</span>
      </header>

      <span class="setting-desc">
        「本地文件」技能只能访问下面这些文件夹（及其子文件夹）：可以查找、阅读文件；整理、移动、新建或修改文件前会先请你确认，并且可以撤销；不会删除文件。被阅读的文件内容会发送给对话模型。
      </span>
      <span v-if="!filesAvailable" class="setting-desc warn">本地文件操作需要在桌面应用中使用</span>

      <ul class="roots">
        <li v-if="toolsStore.fileRoots.length === 0" class="setting-desc">还没有授权任何文件夹</li>
        <li v-for="root in toolsStore.fileRoots" :key="root.path" class="root">
          <span class="root-text">
            <span>{{ root.name }}</span>
            <span class="setting-desc">{{ root.path }}</span>
          </span>
          <button class="remove" type="button" title="取消授权" @click="toolsStore.removeRoot(root.path)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </li>
      </ul>

      <div v-if="suggestions.length" class="row wrap">
        <span class="setting-desc">添加常用位置：</span>
        <button v-for="folder in suggestions" :key="folder.path" class="chip" type="button" @click="addRoot(folder.path, folder.name)">
          + {{ folder.name }}
        </button>
      </div>
      <form class="row" @submit.prevent="addRoot(newPath)">
        <input v-model="newPath" class="field" placeholder="其他文件夹的完整路径，如 D:\工作资料" :disabled="!filesAvailable" />
        <button class="reset-button" type="submit" :disabled="!newPath.trim()">添加</button>
      </form>
      <span v-if="rootError" class="setting-desc warn">{{ rootError }}</span>
    </section>

    <section class="tile">
      <header class="tile-head">
        <span class="tile-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
            <path d="M3 3v5h5M12 7v5l3 3" />
          </svg>
        </span>
        <span class="tile-title">文件操作记录</span>
      </header>

      <p v-if="toolsStore.fileHistory.length === 0" class="setting-desc">还没有整理、移动或写入过文件</p>
      <ul class="roots">
        <li v-for="operation in toolsStore.fileHistory" :key="operation.id" class="root" :class="{ undone: operation.undone }">
          <span class="root-text">
            <span>{{ operation.description }}</span>
            <span class="setting-desc">{{ formatTime(operation.createdAt) }} · {{ describeOperation(operation) }}</span>
          </span>
          <button class="reset-button" type="button" :disabled="operation.undone" @click="undo(operation)">
            {{ operation.undone ? '已撤销' : '撤销' }}
          </button>
        </li>
      </ul>
      <span v-if="undoMessage" class="setting-desc">{{ undoMessage }}</span>
    </section>
  </div>
</template>

<style scoped src="../../css/settings/SceneSetting.css"></style>
<style scoped>
.field {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  font: inherit;
  font-size: 13px;
  color: #fff;
  background: rgb(0 0 0 / 28%);
  border: 1px solid rgb(255 255 255 / 12%);
  border-radius: 10px;
  outline: none;
}

.field:focus {
  border-color: var(--mint);
}

.field option {
  color: #fff;
  background: #1e1e22;
}

.row {
  display: flex;
  gap: 10px;
  align-items: center;
}

.row.wrap {
  flex-wrap: wrap;
  gap: 6px;
}

.roots {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.root {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 8px 10px;
  font-size: 13px;
  background: rgb(255 255 255 / 4%);
  border-radius: 10px;
}

.root.undone {
  opacity: 0.5;
}

.root-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  word-break: break-all;
}

.chip {
  padding: 4px 10px;
  font: inherit;
  font-size: 12px;
  color: var(--mint);
  cursor: pointer;
  background: rgb(52 211 153 / 10%);
  border: 1px solid rgb(52 211 153 / 30%);
  border-radius: 999px;
}

.remove {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  color: rgb(255 255 255 / 45%);
  cursor: pointer;
  background: transparent;
  border: none;
  border-radius: 6px;
}

.remove svg {
  width: 12px;
  height: 12px;
}

.remove:hover {
  color: #ff8a8a;
  background: rgb(255 107 107 / 14%);
}

.setting-desc.warn {
  color: #fbbf24;
}

.setting-desc.ok {
  color: var(--mint);
}
</style>
