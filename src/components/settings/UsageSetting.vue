<script setup lang="ts">
import type { Currency, ModelPrice, UsageKind, UsageTotals } from '@/stores/usage'
import { computed, ref } from 'vue'
import { useProvidersStore } from '@/stores/providers'
import { addTotals, costOf, CURRENCY_SYMBOLS, dayKey, emptyTotals, priceKey, USAGE_KIND_LABELS, useUsageStore } from '@/stores/usage'

const usageStore = useUsageStore()
const providersStore = useProvidersStore()

// ===== 时间范围 =====

type Period = 'today' | 'week' | 'month' | 'days30' | 'all'
const PERIODS: { id: Period, label: string }[] = [
  { id: 'today', label: '今天' },
  { id: 'week', label: '近 7 天' },
  { id: 'month', label: '本月' },
  { id: 'days30', label: '近 30 天' },
  { id: 'all', label: '全部' },
]
const period = ref<Period>('month')

const DAY = 86_400_000

/** 统计从哪一天开始（含），空字符串表示全部 */
function sinceDay(value: Period, now = new Date()): string {
  switch (value) {
    case 'today': return dayKey(now)
    case 'week': return dayKey(new Date(now.getTime() - 6 * DAY))
    case 'month': return dayKey(new Date(now.getFullYear(), now.getMonth(), 1))
    case 'days30': return dayKey(new Date(now.getTime() - 29 * DAY))
    case 'all': return ''
  }
}

// ===== 汇总：按 Provider、模型 =====

interface ModelRow {
  key: string
  providerId: string
  modelId: string
  kind: UsageKind
  totals: UsageTotals
  price: ModelPrice | undefined
  cost: number | null
}

interface ProviderGroup {
  providerId: string
  name: string
  deleted: boolean
  rows: ModelRow[]
  costs: Partial<Record<Currency, number>>
  requests: number
}

const groups = computed<ProviderGroup[]>(() => {
  const since = sinceDay(period.value)
  const rows = new Map<string, ModelRow>()
  const names = new Map<string, string>()
  for (const record of usageStore.records) {
    if (record.day < since) continue
    const key = `${record.providerId}|${record.modelId}|${record.kind}`
    let row = rows.get(key)
    if (!row) {
      row = { key, providerId: record.providerId, modelId: record.modelId, kind: record.kind, totals: emptyTotals(), price: undefined, cost: null }
      rows.set(key, row)
    }
    addTotals(row.totals, record)
    names.set(record.providerId, record.providerName)
  }

  const byProvider = new Map<string, ProviderGroup>()
  for (const row of rows.values()) {
    row.price = usageStore.prices[priceKey(row.providerId, row.modelId)]
    row.cost = costOf(row.kind, row.totals, row.price)
    let group = byProvider.get(row.providerId)
    if (!group) {
      const provider = providersStore.getProviderById(row.providerId)
      group = { providerId: row.providerId, name: provider?.name ?? names.get(row.providerId) ?? row.providerId, deleted: !provider, rows: [], costs: {}, requests: 0 }
      byProvider.set(row.providerId, group)
    }
    group.rows.push(row)
    group.requests += row.totals.requests
    if (row.cost !== null && row.price) group.costs[row.price.currency] = (group.costs[row.price.currency] ?? 0) + row.cost
  }

  const weight = (costs: Partial<Record<Currency, number>>) => Object.values(costs).reduce((sum, cost) => sum + (cost ?? 0), 0)
  for (const group of byProvider.values()) {
    group.rows.sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || b.totals.requests - a.totals.requests)
  }
  return [...byProvider.values()].sort((a, b) => weight(b.costs) - weight(a.costs) || b.requests - a.requests)
})

const overview = computed(() => {
  const costs: Partial<Record<Currency, number>> = {}
  const totals = emptyTotals()
  let unpriced = 0
  for (const group of groups.value) {
    for (const [currency, cost] of Object.entries(group.costs) as [Currency, number][]) costs[currency] = (costs[currency] ?? 0) + cost
    for (const row of group.rows) {
      addTotals(totals, row.totals)
      if (row.cost === null) unpriced++
    }
  }
  return { costs, totals, unpriced }
})

// ===== 显示 =====

function formatCount(value: number): string {
  if (value < 10_000) return Math.round(value).toLocaleString()
  if (value < 100_000_000) return `${(value / 10_000).toFixed(value < 100_000 ? 1 : 0)} 万`
  return `${(value / 100_000_000).toFixed(2)} 亿`
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${Math.round(seconds % 60)} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

function formatCost(cost: number, currency: Currency): string {
  const digits = cost > 0 && cost < 0.01 ? 4 : 2
  return `${CURRENCY_SYMBOLS[currency]}${cost.toFixed(digits)}`
}

function formatCosts(costs: Partial<Record<Currency, number>>): string {
  const parts = (Object.entries(costs) as [Currency, number][]).map(([currency, cost]) => formatCost(cost, currency))
  return parts.length ? parts.join(' + ') : '—'
}

function usageText(row: ModelRow): string {
  const { totals } = row
  switch (row.kind) {
    case 'llm': {
      const cached = totals.cachedInputTokens ? `（缓存命中 ${formatCount(totals.cachedInputTokens)}）` : ''
      return `输入 ${formatCount(totals.inputTokens)}${cached} · 输出 ${formatCount(totals.outputTokens)} token`
    }
    case 'embedding': return `${formatCount(totals.inputTokens)} token`
    case 'tts': return `${formatCount(totals.characters)} 字符`
    case 'asr': return formatDuration(totals.seconds)
  }
}

// ===== 价格 =====

type PriceField = Exclude<keyof ModelPrice, 'currency'>

const PRICE_FIELDS: Record<UsageKind, { field: PriceField, label: string, unit: string, optional?: boolean }[]> = {
  llm: [
    { field: 'input', label: '输入', unit: '百万 token' },
    { field: 'cachedInput', label: '缓存命中的输入', unit: '百万 token', optional: true },
    { field: 'output', label: '输出', unit: '百万 token' },
  ],
  embedding: [{ field: 'input', label: '输入', unit: '百万 token' }],
  tts: [{ field: 'characters', label: '合成', unit: '百万字符' }],
  asr: [{ field: 'hour', label: '识别', unit: '小时音频' }],
}

const editing = ref<string | null>(null)

function toggleEditing(row: ModelRow) {
  editing.value = editing.value === row.key ? null : row.key
}

function setCurrency(row: ModelRow, currency: Currency) {
  usageStore.setPrice(row.providerId, row.modelId, { ...row.price, currency })
}

function setField(row: ModelRow, field: PriceField, event: Event) {
  const text = (event.target as HTMLInputElement).value.trim()
  const value = text === '' ? undefined : Number(text)
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) return
  const price: ModelPrice = { currency: 'CNY', ...row.price }
  if (value === undefined) delete price[field]
  else price[field] = value
  usageStore.setPrice(row.providerId, row.modelId, price)
}

function clearPrice(row: ModelRow) {
  usageStore.setPrice(row.providerId, row.modelId, null)
}

// ===== 清空 =====

const confirmingClear = ref(false)

function clearRecords() {
  if (!confirmingClear.value) {
    confirmingClear.value = true
    return
  }
  usageStore.clearRecords()
  confirmingClear.value = false
}
</script>

<template>
  <div class="scene-setting">
    <!-- 概览 -->
    <section class="overview">
      <div class="overview-text">
        <span class="overview-label">{{ PERIODS.find((item) => item.id === period)!.label }}的费用（估算）</span>
        <span class="overview-level">{{ formatCosts(overview.costs) }}</span>
        <span class="overview-hint">
          <template v-if="overview.unpriced">{{ overview.unpriced }} 个模型还没有设置价格，没有算进费用；</template>
          按你填写的价格估算，以服务商的账单为准
        </span>
        <div class="overview-stats">
          <span class="stat"><b>{{ formatCount(overview.totals.requests) }}</b>请求</span>
          <span class="stat"><b>{{ formatCount(overview.totals.inputTokens) }}</b>输入 token</span>
          <span class="stat"><b>{{ formatCount(overview.totals.outputTokens) }}</b>输出 token</span>
          <span v-if="overview.totals.characters" class="stat"><b>{{ formatCount(overview.totals.characters) }}</b>合成字符</span>
          <span v-if="overview.totals.seconds" class="stat"><b>{{ formatDuration(overview.totals.seconds) }}</b>识别音频</span>
        </div>
      </div>
    </section>

    <div class="fps-options periods" role="tablist">
      <button
        v-for="item in PERIODS"
        :key="item.id"
        type="button"
        class="fps-chip"
        :class="{ active: period === item.id }"
        @click="period = item.id"
      >
        {{ item.label }}
      </button>
    </div>

    <p v-if="groups.length === 0" class="usage-empty">这段时间还没有用量记录，调用模型后会自动记录</p>

    <!-- 每个 Provider -->
    <section v-for="group in groups" :key="group.providerId" class="tile">
      <header class="tile-head">
        <span class="tile-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V9M10 19V5M16 19v-7M22 19H2" /></svg>
        </span>
        <span class="tile-title">{{ group.name }}<em v-if="group.deleted" class="deleted">已删除</em></span>
        <span class="tile-summary">{{ formatCosts(group.costs) }} · {{ formatCount(group.requests) }} 次</span>
      </header>

      <ul class="usage-rows">
        <li v-for="row in group.rows" :key="row.key" class="usage-row" :class="{ open: editing === row.key }">
          <div class="row-main">
            <div class="row-model">
              <span class="row-name" :title="row.modelId">{{ row.modelId }}</span>
              <span class="row-usage">{{ USAGE_KIND_LABELS[row.kind] }} · {{ formatCount(row.totals.requests) }} 次 · {{ usageText(row) }}</span>
            </div>
            <span class="row-cost" :class="{ unpriced: row.cost === null }">
              {{ row.cost === null || !row.price ? '未设置价格' : formatCost(row.cost, row.price.currency) }}
            </span>
            <button type="button" class="reset-button price-button" @click="toggleEditing(row)">
              {{ editing === row.key ? '收起' : '价格' }}
            </button>
          </div>

          <div v-if="editing === row.key" class="price-editor">
            <div class="currency">
              <button
                v-for="(symbol, currency) in CURRENCY_SYMBOLS"
                :key="currency"
                type="button"
                class="fps-chip"
                :class="{ active: (row.price?.currency ?? 'CNY') === currency }"
                @click="setCurrency(row, currency)"
              >
                {{ symbol }} {{ currency === 'CNY' ? '人民币' : '美元' }}
              </button>
            </div>
            <label v-for="item in PRICE_FIELDS[row.kind]" :key="item.field" class="price-field">
              <span>{{ item.label }}<em v-if="item.optional">（不填时按输入价格）</em></span>
              <span class="price-input">
                {{ CURRENCY_SYMBOLS[row.price?.currency ?? 'CNY'] }}
                <input
                  type="number"
                  min="0"
                  step="any"
                  :value="row.price?.[item.field] ?? ''"
                  placeholder="0"
                  @change="setField(row, item.field, $event)"
                />
                / {{ item.unit }}
              </span>
            </label>
            <div class="price-actions">
              <span class="setting-desc">价格按 Provider + 模型分别保存，修改后所有时间段的费用都按新价格重新计算</span>
              <button v-if="row.price" type="button" class="reset-button" @click="clearPrice(row)">清除价格</button>
            </div>
          </div>
        </li>
      </ul>
    </section>

    <footer v-if="usageStore.records.length" class="usage-footer">
      <span class="setting-desc">被打断、出错的请求拿不到用量，不会计入；记录保存最近 400 天</span>
      <button type="button" class="reset-button" @click="clearRecords" @blur="confirmingClear = false">
        {{ confirmingClear ? '再点一次确认清空' : '清空用量记录' }}
      </button>
    </footer>
  </div>
</template>

<style scoped src="../../css/settings/SceneSetting.css"></style>
<style scoped>
.periods {
  margin: 0;
}

.usage-empty {
  padding: 24px 0;
  margin: 0;
  font-size: 12px;
  color: rgb(255 255 255 / 40%);
  text-align: center;
}

.deleted {
  margin-left: 6px;
  font-size: 11px;
  font-style: normal;
  font-weight: 400;
  color: rgb(255 255 255 / 40%);
}

.usage-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.usage-row {
  background: rgb(255 255 255 / 4%);
  border: 1px solid transparent;
  border-radius: 10px;
}

.usage-row.open {
  border-color: rgb(52 211 153 / 35%);
}

.row-main {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 8px 10px;
}

.row-model {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.row-name {
  overflow: hidden;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px;
  font-weight: 600;
  color: rgb(255 255 255 / 90%);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-usage {
  font-size: 11px;
  color: rgb(255 255 255 / 45%);
}

.row-cost {
  flex-shrink: 0;
  font-size: 13px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--mint);
}

.row-cost.unpriced {
  font-size: 11px;
  font-weight: 400;
  color: rgb(255 255 255 / 35%);
}

.price-button {
  flex-shrink: 0;
  margin-left: 0;
}

.price-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px 10px;
  border-top: 1px solid rgb(255 255 255 / 6%);
}

.currency {
  display: flex;
  gap: 6px;
}

.price-field {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: rgb(255 255 255 / 75%);
}

.price-field em {
  font-size: 11px;
  font-style: normal;
  color: rgb(255 255 255 / 40%);
}

.price-input {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  font-size: 11px;
  color: rgb(255 255 255 / 50%);
}

.price-input input {
  width: 90px;
  padding: 5px 8px;
  font: inherit;
  font-size: 12px;
  color: #fff;
  background: rgb(0 0 0 / 28%);
  border: 1px solid rgb(255 255 255 / 12%);
  border-radius: 8px;
  outline: none;
}

.price-input input:focus {
  border-color: var(--mint);
}

.price-actions,
.usage-footer {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
}
</style>
