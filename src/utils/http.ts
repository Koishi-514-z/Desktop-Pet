import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { isTauri } from '@/composables/desktop'

/**
 * 访问网络：桌面应用中通过 Rust 端发起请求，不受浏览器跨域限制（用于搜索接口与抓取网页）；
 * 在浏览器中运行时退化为普通的 fetch（大多数网站会因跨域限制而失败）
 */
export function httpFetch(input: string, init?: RequestInit): Promise<Response> {
  return isTauri ? tauriFetch(input, init) : fetch(input, init)
}
