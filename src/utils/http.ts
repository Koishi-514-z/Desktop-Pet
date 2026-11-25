import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { isTauri } from '@/composables/desktop'

/**
 * 访问网络：桌面应用中通过 Rust 端发起请求，不受浏览器跨域限制（用于搜索接口、抓取网页，以及不允许跨域访问的模型接口）；
 * 在浏览器中运行时退化为普通的 fetch（大多数网站会因跨域限制而失败）。
 * 参数与 fetch 相同，可以直接作为 AI SDK provider 的 fetch 选项
 */
export function httpFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return isTauri ? tauriFetch(input, init) : fetch(input, init)
}
