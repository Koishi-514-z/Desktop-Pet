import type { SearchSettings } from '@/web/search'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { checkUrl, detectCharset, extractArticle, fetchPage, htmlToText, isPrivateHost } from '@/web/page'
import { webSearch } from '@/web/search'

// 模拟网络请求：按网址返回预设的响应，并记录请求
const http = vi.hoisted(() => ({
  routes: new Map<string, () => Response>(),
  requests: [] as { url: string, init?: RequestInit }[],
}))

vi.mock('@/utils/http', () => ({
  httpFetch: async (url: string, init?: RequestInit) => {
    http.requests.push({ url, init })
    const route = http.routes.get(url)
    if (!route) throw new Error(`未预设的请求：${url}`)
    return route()
  },
}))

function json(data: unknown, status = 200) {
  return () => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

const settings = (patch: Partial<SearchSettings>): SearchSettings => ({ provider: 'none', tavilyKey: '', braveKey: '', searxngUrl: '', ...patch })

beforeEach(() => {
  http.routes.clear()
  http.requests = []
})

describe('网址校验', () => {
  it('拦截本机与局域网地址', () => {
    const privateHosts = ['localhost', 'printer.local', '127.0.0.1', '10.0.0.8', '172.20.1.1', '192.168.1.1', '169.254.1.1', '[::1]', 'fd00::1', '0.0.0.0', '2130706433']
    const publicHosts = ['example.com', '8.8.8.8', '172.32.0.1', 'localhost.example.com']
    // 列出判断错误的地址，失败时便于定位
    expect(privateHosts.filter((host) => !isPrivateHost(host))).toEqual([])
    expect(publicHosts.filter((host) => isPrivateHost(host))).toEqual([])
  })

  it('只允许公网的 http / https 网址', () => {
    expect(checkUrl('https://example.com/a?b=1').hostname).toBe('example.com')
    expect(() => checkUrl('file:///C:/Windows/win.ini')).toThrow('只能读取 http')
    expect(() => checkUrl('http://192.168.1.1/admin')).toThrow('局域网')
    expect(() => checkUrl('http://127.1/')).toThrow('局域网')
    expect(() => checkUrl('不是网址')).toThrow('无效的网址')
  })
})

describe('网页解析', () => {
  it('从响应头或 meta 中识别字符集', () => {
    const bytes = (text: string) => new TextEncoder().encode(text)
    expect(detectCharset('text/html; charset=GBK', bytes(''))).toBe('gbk')
    expect(detectCharset('text/html', bytes('<head><meta charset="gb2312"></head>'))).toBe('gb2312')
    expect(detectCharset(null, bytes('<meta http-equiv="Content-Type" content="text/html; charset=big5">'))).toBe('big5')
    expect(detectCharset(null, bytes('<html>'))).toBe('utf-8')
  })

  it('提取文章正文，去掉导航与脚本', () => {
    const paragraph = '这是一段足够长的正文内容，用来模拟真实网页中的文章段落。'.repeat(8)
    const html = `<html><head><title>示例文章 - 示例网站</title></head><body>
      <nav>首页 | 新闻 | 关于</nav>
      <article><h1>示例文章</h1><p>${paragraph}</p><p>${paragraph}</p></article>
      <script>alert('x')</script><footer>版权所有</footer></body></html>`
    const article = extractArticle(html, 'https://example.com/post')
    expect(article.text).toContain('足够长的正文内容')
    expect(article.text).not.toContain('首页 | 新闻')
    expect(article.text).not.toContain('alert')
  })

  it('按页面结构转成文本：单元格分隔、保留代码缩进、去掉零宽空格与图标字符', () => {
    const html = `<div>
      <h2>安装 <a class="anchor" href="#install">​</a></h2>
      <table><tr><th>作者</th><td>张三</td><td>李四</td></tr><tr><th>版本</th><td>2.0</td></tr></table>
      <ul><li>第一项</li><li>第二<b>项</b></li></ul>
      <p>第一行<br>第二行 <i class="iconfont"></i>结束</p>
      <pre><code>if (ok) {\n    run()\n}</code></pre>
      <script>alert('x')</script>
    </div>`
    const root = new DOMParser().parseFromString(html, 'text/html').body
    expect(htmlToText(root)).toBe([
      '安装',
      '作者 | 张三 | 李四',
      '版本 | 2.0',
      '- 第一项',
      '- 第二项',
      '第一行',
      '第二行 结束',
      'if (ok) {',
      '    run()',
      '}',
    ].join('\n'))
  })

  it('og:title 只是站点名时使用更具体的网页标题', () => {
    const paragraph = '这是一段足够长的正文内容，用来模拟真实网页中的文章段落。'.repeat(8)
    const html = `<html><head><title>简介 | 示例框架</title><meta property="og:title" content="示例框架"></head>
      <body><article><p>${paragraph}</p><p>${paragraph}</p></article></body></html>`
    expect(extractArticle(html, 'https://example.com/guide').title).toBe('简介 | 示例框架')
  })

  it('正文太短时退化为整个页面的文字', () => {
    const article = extractArticle('<html><head><title>短页面</title></head><body><nav>导航</nav><div>只有一句话</div></body></html>', 'https://example.com')
    expect(article.title).toBe('短页面')
    expect(article.text).toBe('只有一句话')
  })
})

describe('读取网页', () => {
  it('按响应头中的字符集解码 GBK 网页，并截断过长的正文', async () => {
    // 「你好世界」的 GBK 编码
    const helloWorld = [0xC4, 0xE3, 0xBA, 0xC3, 0xCA, 0xC0, 0xBD, 0xE7]
    const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0))
    const body = new Uint8Array([
      ...ascii('<html><head><title>GBK</title></head><body><div>'),
      ...Array.from({ length: 100 }, () => helloWorld).flat(),
      ...ascii('</div></body></html>'),
    ])
    http.routes.set('https://example.com/zh', () => new Response(body, { headers: { 'Content-Type': 'text/html; charset=gbk' } }))

    const page = await fetchPage('https://example.com/zh', { maxChars: 50 })
    expect(page.text.startsWith('你好世界你好世界')).toBe(true)
    expect(page.text).toHaveLength(50)
    expect(page.truncated).toBe(true)
    expect(page.totalChars).toBe(400)
  })

  it('跟随重定向时重新校验网址，拒绝跳转到内网', async () => {
    http.routes.set('https://example.com/go', () => new Response(null, { status: 302, headers: { Location: 'http://192.168.1.1/admin' } }))
    await expect(fetchPage('https://example.com/go')).rejects.toThrow('局域网')
    expect(http.requests).toHaveLength(1)

    http.routes.set('https://example.com/old', () => new Response(null, { status: 301, headers: { Location: '/new' } }))
    http.routes.set('https://example.com/new', () => new Response('<html><body><p>新地址的内容</p></body></html>', { headers: { 'Content-Type': 'text/html' } }))
    const page = await fetchPage('https://example.com/old')
    expect(page.url).toBe('https://example.com/new')
    expect(page.text).toBe('新地址的内容')
  })

  it('拒绝不支持的内容类型', async () => {
    http.routes.set('https://example.com/a.pdf', () => new Response('%PDF', { headers: { 'Content-Type': 'application/pdf' } }))
    await expect(fetchPage('https://example.com/a.pdf')).rejects.toThrow('application/pdf')
  })
})

describe('网页搜索', () => {
  it('Tavily：带上 API Key，整理结果与直接回答', async () => {
    http.routes.set('https://api.tavily.com/search', json({
      answer: 'Tauri 2 已发布',
      results: [
        { title: 'Tauri 2.0', url: 'https://v2.tauri.app', content: '  Tauri 2.0 is <b>stable</b>  ', published_date: '2024-10-02' },
        { title: '无效链接', url: 'javascript:alert(1)', content: '' },
      ],
    }))
    const response = await webSearch('Tauri 2', settings({ provider: 'tavily', tavilyKey: ' tvly-key ' }), { limit: 3 })

    const request = http.requests[0]!
    expect((request.init!.headers as Record<string, string>).Authorization).toBe('Bearer tvly-key')
    expect(JSON.parse(request.init!.body as string)).toMatchObject({ query: 'Tauri 2', max_results: 3, include_answer: true })
    expect(response).toEqual({
      answer: 'Tauri 2 已发布',
      results: [{ title: 'Tauri 2.0', url: 'https://v2.tauri.app', snippet: 'Tauri 2.0 is stable', publishedAt: '2024-10-02' }],
    })
  })

  it('Brave：去掉摘要中的 HTML 标签', async () => {
    http.routes.set('https://api.search.brave.com/res/v1/web/search?q=vue%203&count=6', json({
      web: { results: [{ title: 'Vue 3', url: 'https://vuejs.org', description: 'The <strong>Progressive</strong> &amp; approachable framework' }] },
    }))
    const response = await webSearch('vue 3', settings({ provider: 'brave', braveKey: 'key' }))
    expect(response.results[0]!.snippet).toBe('The Progressive & approachable framework')
  })

  it('SearXNG：未启用 JSON 格式时给出提示', async () => {
    http.routes.set('http://searx.example.com/search?q=x&format=json', () => new Response('Forbidden', { status: 403 }))
    await expect(webSearch('x', settings({ provider: 'searxng', searxngUrl: 'http://searx.example.com/' }))).rejects.toThrow('search.formats')
  })

  it('没有配置或缺少 API Key 时给出提示', async () => {
    await expect(webSearch('x', settings({ provider: 'none' }))).rejects.toThrow('还没有配置网页搜索服务')
    await expect(webSearch('x', settings({ provider: 'tavily' }))).rejects.toThrow('API Key')
    http.routes.set('https://api.tavily.com/search', json({ detail: 'unauthorized' }, 401))
    await expect(webSearch('x', settings({ provider: 'tavily', tavilyKey: 'bad' }))).rejects.toThrow('检查 API Key')
  })
})
