import { Readability } from '@mozilla/readability'
import { isTauri } from '@/composables/desktop'
import { httpFetch } from '@/utils/http'

// 网页正文默认最多保留的字数
const DEFAULT_MAX_CHARS = 8000
// 网页的最大大小
const MAX_BYTES = 5 * 1024 * 1024
// 最多跟随的重定向次数
const MAX_REDIRECTS = 5

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

export interface WebPage {
  /** 最终的网址（跟随重定向后） */
  url: string
  title: string
  siteName?: string
  byline?: string
  publishedTime?: string
  /** 正文 */
  text: string
  truncated: boolean
  totalChars: number
}

/** IPv4 地址是否属于本机、局域网或保留地址 */
function isPrivateIPv4(host: string): boolean {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts as [number, number, number, number]
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a >= 224
}

/** 是否为本机或局域网地址：读取网页时不允许访问，避免被网页内容诱导去访问内网服务 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!host || host === 'localhost' || /\.(?:localhost|local|internal|lan|home|intranet)$/.test(host)) return true
  if (/^\d+(?:\.\d+){3}$/.test(host)) return isPrivateIPv4(host)
  // 纯数字或十六进制形式的 IPv4（如 http://2130706433/）
  if (/^(?:0x[0-9a-f]+|\d+)$/.test(host)) return true
  if (host.includes(':')) {
    // IPv6：本机、链路本地、唯一本地地址，以及映射的 IPv4 地址
    return host === '::' || host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:')
  }
  return false
}

/** 校验网址：只允许公网的 http / https 地址 */
export function checkUrl(input: string): URL {
  let url: URL
  try {
    url = new URL(input.trim())
  }
  catch {
    throw new Error(`无效的网址：${input}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`只能读取 http 或 https 网页：${input}`)
  if (isPrivateHost(url.hostname)) throw new Error(`不能读取本机或局域网的地址：${url.hostname}`)
  return url
}

/** 从响应头或网页的 <meta> 中找出字符集 */
export function detectCharset(contentType: string | null, head: Uint8Array): string {
  const fromHeader = contentType?.match(/charset=["']?([\w-]+)/i)?.[1]
  if (fromHeader) return fromHeader.toLowerCase()
  const ascii = new TextDecoder('latin1').decode(head.slice(0, 4096))
  const fromMeta = ascii.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1]
  return fromMeta?.toLowerCase() ?? 'utf-8'
}

function decode(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes)
  }
  catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/** 整理空白：合并连续的空格，最多保留一个空行 */
export function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v 　]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// 块级元素：前后换行
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'caption', 'dd', 'details', 'div', 'dl', 'dt', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'summary', 'table', 'tr', 'ul',
])
// 不含可读文字的元素
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object'])
// 没有可读含义的字符：零宽空格（常见于标题锚点）与图标字体使用的私有区字符
const INVISIBLE_CHARS = /[​﻿-]/g
// 代码块中的空格与换行先换成这两个字符，避免整理空白时被合并，最后再换回来
const KEPT_SPACE = ''
const KEPT_NEWLINE = ''

/** 把 HTML 转成纯文本：每个块级元素占一行，表格的单元格之间用「|」分隔，代码块保持原样 */
export function htmlToText(root: Node): string {
  const parts: string[] = []
  const walk = (node: Node, pre: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.nodeValue ?? '').replace(INVISIBLE_CHARS, '')
      parts.push(pre
        ? text.replace(/\t/g, '  ').replace(/ /g, KEPT_SPACE).replace(/\r?\n/g, KEPT_NEWLINE)
        : text.replace(/\s+/g, ' '))
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const element = node as Element
    const tag = element.localName
    if (SKIP_TAGS.has(tag)) return
    if (tag === 'br') {
      parts.push('\n')
      return
    }
    if ((tag === 'td' || tag === 'th') && element.previousElementSibling) parts.push(' | ')
    const block = BLOCK_TAGS.has(tag)
    if (block) parts.push('\n')
    if (tag === 'li') parts.push('- ')
    element.childNodes.forEach((child) => walk(child, pre || tag === 'pre'))
    if (block) parts.push('\n')
  }
  walk(root, false)
  return cleanText(parts.join(''))
    .replace(/\n{2,}/g, '\n')
    .replace(//g, ' ')
    .replace(//g, '\n')
    .replace(/^\n+|\n+$/g, '')
}

/** 从 HTML 中提取正文：优先用 Readability 提取文章主体，提取失败时退化为整个页面的文字 */
export function extractArticle(html: string, url: string): Omit<WebPage, 'truncated' | 'totalChars' | 'url'> {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const base = doc.createElement('base')
  base.href = url
  doc.head?.prepend(base)
  const pageTitle = doc.title?.trim() ?? ''

  const article = new Readability<Node>(doc.cloneNode(true) as Document, { serializer: (node) => node }).parse()
  const articleText = article?.content ? htmlToText(article.content) : ''
  if (article && articleText.length >= 200) {
    // 有些网站的 og:title 只是站点名（如「Vue.js」），这时网页标题（「Introduction | Vue.js」）更具体
    const articleTitle = article.title?.trim() ?? ''
    const title = !articleTitle || (pageTitle.length > articleTitle.length && pageTitle.includes(articleTitle)) ? pageTitle : articleTitle
    return {
      title,
      text: articleText,
      ...(article.siteName ? { siteName: article.siteName } : {}),
      ...(article.byline ? { byline: article.byline } : {}),
      ...(article.publishedTime ? { publishedTime: article.publishedTime } : {}),
    }
  }

  doc.querySelectorAll('nav, footer, header, aside, form').forEach((el) => el.remove())
  return { title: pageTitle, text: doc.body ? htmlToText(doc.body) : '' }
}

async function fetchFollowingRedirects(url: URL, signal?: AbortSignal): Promise<{ response: Response, url: URL }> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await httpFetch(current.href, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal,
      // 桌面应用中不自动跟随重定向，每一跳都重新校验，避免被重定向到内网地址
      ...(isTauri ? { maxRedirections: 0 } : {}),
    } as RequestInit)
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      current = checkUrl(new URL(location, current).href)
      continue
    }
    return { response, url: current }
  }
  throw new Error('网页重定向次数过多')
}

/** 读取网页并提取正文 */
export async function fetchPage(input: string, options: { maxChars?: number, signal?: AbortSignal } = {}): Promise<WebPage> {
  const { response, url } = await fetchFollowingRedirects(checkUrl(input), options.signal)
  if (!response.ok) throw new Error(`网页打开失败（${response.status}）：${url.href}`)

  const contentType = response.headers.get('content-type')
  const length = Number(response.headers.get('content-length') ?? 0)
  if (length > MAX_BYTES) throw new Error('网页太大，无法读取')
  const isHtml = !contentType || /html|xml/i.test(contentType)
  if (!isHtml && !/^text\/|json/i.test(contentType)) {
    throw new Error(`暂不支持读取这种类型的内容（${contentType.split(';')[0]}）`)
  }

  const bytes = new Uint8Array(await response.arrayBuffer()).slice(0, MAX_BYTES)
  const raw = decode(bytes, detectCharset(contentType, bytes))
  const page = isHtml ? extractArticle(raw, url.href) : { title: url.href, text: cleanText(raw) }
  if (!page.text) throw new Error('没有从网页中提取到文字（可能需要登录，或内容由脚本动态生成）')

  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  const totalChars = page.text.length
  return {
    ...page,
    url: url.href,
    text: totalChars > maxChars ? page.text.slice(0, maxChars) : page.text,
    truncated: totalChars > maxChars,
    totalChars,
  }
}
