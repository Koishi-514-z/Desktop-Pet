import { httpFetch } from '@/utils/http'

/** 网页搜索服务 */
export type SearchProvider = 'tavily' | 'brave' | 'searxng'

export interface SearchSettings {
  provider: SearchProvider | 'none'
  tavilyKey: string
  braveKey: string
  /** 自建 SearXNG 实例的地址，如 http://localhost:8080（需要在实例中启用 JSON 格式） */
  searxngUrl: string
}

export const SEARCH_PROVIDERS: { id: SearchProvider, name: string, description: string }[] = [
  { id: 'tavily', name: 'Tavily', description: '为 AI 设计的搜索接口，结果附带网页摘要，每月有免费额度（tavily.com）' },
  { id: 'brave', name: 'Brave Search', description: '独立索引的搜索引擎接口，每月有免费额度（brave.com/search/api）' },
  { id: 'searxng', name: 'SearXNG', description: '自建的开源元搜索引擎，免费，需要在实例设置中启用 JSON 格式' },
]

export interface WebResult {
  title: string
  url: string
  snippet: string
  /** 发布时间（如果搜索服务提供） */
  publishedAt?: string
}

export interface WebSearchResponse {
  results: WebResult[]
  /** 搜索服务直接给出的简短回答（仅 Tavily） */
  answer?: string
}

const SNIPPET_LENGTH = 300

/** 去掉摘要中的 HTML 标签与多余空白 */
function clean(text: unknown): string {
  return String(text ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' })[entity]!)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SNIPPET_LENGTH)
}

async function readJson(response: Response, provider: string): Promise<Record<string, unknown>> {
  if (response.status === 401 || response.status === 403) throw new Error(`${provider} 拒绝了请求，请检查 API Key 是否正确`)
  if (response.status === 429) throw new Error(`${provider} 的请求次数超出限制，请稍后再试`)
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`${provider} 请求失败（${response.status}）${body ? `：${body.slice(0, 200)}` : ''}`)
  }
  return response.json() as Promise<Record<string, unknown>>
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') : []
}

function toResults(items: Record<string, unknown>[], fields: { title: string, url: string, snippet: string, date?: string }): WebResult[] {
  return items
    .map((item) => ({
      title: clean(item[fields.title]),
      url: String(item[fields.url] ?? ''),
      snippet: clean(item[fields.snippet]),
      ...(fields.date && item[fields.date] ? { publishedAt: String(item[fields.date]) } : {}),
    }))
    .filter((result) => /^https?:\/\//i.test(result.url))
}

/** 使用设置中的搜索服务搜索互联网 */
export async function webSearch(query: string, settings: SearchSettings, options: { limit?: number, signal?: AbortSignal } = {}): Promise<WebSearchResponse> {
  const limit = Math.min(Math.max(options.limit ?? 6, 1), 10)
  const { signal } = options

  switch (settings.provider) {
    case 'tavily': {
      if (!settings.tavilyKey.trim()) throw new Error('还没有填写 Tavily 的 API Key')
      const response = await httpFetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.tavilyKey.trim()}` },
        body: JSON.stringify({ query, max_results: limit, search_depth: 'basic', include_answer: true }),
        signal,
      })
      const data = await readJson(response, 'Tavily')
      return {
        results: toResults(records(data.results), { title: 'title', url: 'url', snippet: 'content', date: 'published_date' }),
        ...(typeof data.answer === 'string' && data.answer ? { answer: data.answer } : {}),
      }
    }
    case 'brave': {
      if (!settings.braveKey.trim()) throw new Error('还没有填写 Brave Search 的 API Key')
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`
      const response = await httpFetch(url, {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': settings.braveKey.trim() },
        signal,
      })
      const data = await readJson(response, 'Brave Search')
      const web = (data.web ?? {}) as Record<string, unknown>
      return { results: toResults(records(web.results), { title: 'title', url: 'url', snippet: 'description', date: 'age' }).slice(0, limit) }
    }
    case 'searxng': {
      const base = settings.searxngUrl.trim().replace(/\/+$/, '')
      if (!base) throw new Error('还没有填写 SearXNG 的地址')
      const response = await httpFetch(`${base}/search?q=${encodeURIComponent(query)}&format=json`, {
        headers: { Accept: 'application/json' },
        signal,
      })
      if (response.status === 403) throw new Error('SearXNG 拒绝了 JSON 格式的请求，请在实例的 settings.yml 中把 json 加入 search.formats')
      const data = await readJson(response, 'SearXNG')
      return { results: toResults(records(data.results), { title: 'title', url: 'url', snippet: 'content', date: 'publishedDate' }).slice(0, limit) }
    }
    default:
      throw new Error('还没有配置网页搜索服务，请在 设置 → Tools 中选择搜索服务')
  }
}
