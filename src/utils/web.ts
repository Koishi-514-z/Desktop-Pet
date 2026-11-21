export interface RequestOptions extends Omit<RequestInit, 'method' | 'body'> {
  /** 拼接到 URL 上的查询参数 */
  params?: Record<string, string | number | boolean | undefined>
  /** 非 string/FormData 类型会被自动 JSON.stringify，并附带 Content-Type: application/json */
  body?: unknown
}

function buildUrl(url: string, params?: RequestOptions['params']): string {
  if (!params) return url

  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.append(key, String(value))
  }

  const query = search.toString()
  if (!query) return url

  return `${url}${url.includes('?') ? '&' : '?'}${query}`
}

async function request<T = unknown>(url: string, method: string, options: RequestOptions = {}): Promise<T> {
  const { params, body, headers, ...rest } = options

  const init: RequestInit = { ...rest, method, headers }
  if (body !== undefined) {
    if (typeof body === 'string' || body instanceof FormData || body instanceof Blob || body instanceof URLSearchParams) {
      init.body = body
    }
    else {
      init.body = JSON.stringify(body)
      init.headers = { 'Content-Type': 'application/json', ...headers }
    }
  }

  const res = await fetch(buildUrl(url, params), init)
  if (!res.ok) throw new Error(`${method} ${url} failed: ${res.status} ${res.statusText}`)

  return res.json() as Promise<T>
}

export function get<T = unknown>(url: string, options?: RequestOptions): Promise<T> {
  return request<T>(url, 'GET', options)
}

export function post<T = unknown>(url: string, options?: RequestOptions): Promise<T> {
  return request<T>(url, 'POST', options)
}

export function put<T = unknown>(url: string, options?: RequestOptions): Promise<T> {
  return request<T>(url, 'PUT', options)
}

export function patch<T = unknown>(url: string, options?: RequestOptions): Promise<T> {
  return request<T>(url, 'PATCH', options)
}

export function del<T = unknown>(url: string, options?: RequestOptions): Promise<T> {
  return request<T>(url, 'DELETE', options)
}
