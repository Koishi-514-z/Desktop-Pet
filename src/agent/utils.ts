import type { ModelMessage } from 'ai'

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 格式化为 YYYY-MM-DD（本地时区） */
export function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 格式化为 YYYY-MM-DD HH:mm:ss 星期X（本地时区） */
export function formatDateTime(date: Date): string {
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  return `${formatDate(date)} ${time} ${WEEKDAYS[date.getDay()]}`
}

export function getWeekday(date: Date): string {
  return WEEKDAYS[date.getDay()]!
}

/** 本地时区描述，如 Asia/Shanghai（UTC+08:00） */
export function describeTimezone(date = new Date()): string {
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  const name = Intl.DateTimeFormat().resolvedOptions().timeZone
  return `${name}（UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}）`
}

/** 将时长格式化为「x天x小时x分钟x秒」 */
export function formatDuration(ms: number): string {
  let seconds = Math.max(0, Math.round(ms / 1000))
  const days = Math.floor(seconds / 86400)
  seconds %= 86400
  const hours = Math.floor(seconds / 3600)
  seconds %= 3600
  const minutes = Math.floor(seconds / 60)
  seconds %= 60

  const parts: string[] = []
  if (days) parts.push(`${days}天`)
  if (hours) parts.push(`${hours}小时`)
  if (minutes) parts.push(`${minutes}分钟`)
  if (seconds || parts.length === 0) parts.push(`${seconds}秒`)
  return parts.join('')
}

/** 截断过长的文本，避免撑爆上下文 */
export function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…（已截断）` : text
}

/** 将任意值序列化为便于 LLM 阅读的字符串 */
export function stringify(value: unknown, maxLength = 4000): string {
  if (value === undefined) return '（无）'
  if (typeof value === 'string') return truncate(value, maxLength)
  try {
    return truncate(JSON.stringify(value), maxLength)
  }
  catch {
    return truncate(String(value), maxLength)
  }
}

function summarizeValue(value: unknown, maxLength: number): string {
  if (typeof value === 'string') return truncate(value.replace(/\s+/g, ' ').trim(), maxLength)
  if (Array.isArray(value)) {
    return value.every((item) => typeof item !== 'object' || item === null)
      ? truncate(value.join('、'), maxLength)
      : `${value.length} 项`
  }
  if (value && typeof value === 'object') return '{…}'
  return String(value)
}

/**
 * 工具参数的一行摘要，如「path: D:\notes.txt，overwrite: true」。
 * valueLength 为每个值保留的长度，totalLength 为整行的长度
 */
export function summarizeInput(input: unknown, options: { valueLength?: number, totalLength?: number } = {}): string {
  const { valueLength = 80, totalLength = 240 } = options
  if (input === undefined || input === null) return ''
  if (typeof input !== 'object' || Array.isArray(input)) return summarizeValue(input, valueLength)
  const parts = Object.entries(input as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${summarizeValue(value, valueLength)}`)
  return truncate(parts.join('，'), totalLength)
}

/** 取消息的纯文本内容 */
export function messageText(message: ModelMessage): string {
  const { content } = message
  if (typeof content === 'string') return content
  return content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
}

/** 取最近的若干条消息作为上下文，并保证以用户消息开头（部分服务商要求首条消息来自用户） */
export function recentMessages(messages: ModelMessage[], count: number): ModelMessage[] {
  const recent = messages.slice(-count)
  const firstUserIndex = recent.findIndex((message) => message.role === 'user')
  return firstUserIndex === -1 ? recent : recent.slice(firstUserIndex)
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 从 LLM 的输出中解析 JSON 对象，兼容代码块包裹、前后夹带说明文字等情况；无法解析时返回 null */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const value: unknown = JSON.parse(match[0])
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  }
  catch {
    return null
  }
}
