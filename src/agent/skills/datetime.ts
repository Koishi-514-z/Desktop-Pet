import type { Skill } from '@/agent/types'
import { tool } from 'ai'
import { z } from 'zod'
import { describeTimezone, formatDate, formatDateTime, getWeekday } from '@/agent/utils'

const DAY_MS = 24 * 60 * 60 * 1000

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')

/** 解析 YYYY-MM-DD 为本地时区当天零点 */
function parseLocalDate(text: string): Date {
  const [year, month, day] = text.split('-').map(Number) as [number, number, number]
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error(`无效的日期：${text}`)
  }
  return date
}

function today(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

export const datetimeSkill: Skill = {
  id: 'datetime',
  name: '日期时间',
  description: '获取当前的日期、时间、星期，计算两个日期相差多少天，推算若干天之前或之后的日期。',
  examples: ['现在几点了', '今天星期几', '离元旦还有几天', '100天后是几号'],
  instructions: `- 询问当前时间、日期、星期时，调用 get_current_time。
- 计算两个日期之间相差的天数时，调用 days_between；省略的年份按最近的未来日期推断（如「元旦」指下一个 1 月 1 日）。
- 推算某天之前或之后若干天的日期时，调用 shift_date。`,
  tools: {
    get_current_time: tool({
      description: '获取当前的本地日期、时间、星期与时区',
      inputSchema: z.object({}),
      execute: async () => {
        const now = new Date()
        return { now: formatDateTime(now), timezone: describeTimezone(now) }
      },
    }),

    days_between: tool({
      description: '计算两个日期相差的天数，to 晚于 from 时结果为正',
      inputSchema: z.object({
        from: dateString.optional().describe('起始日期 YYYY-MM-DD，省略时为今天'),
        to: dateString.describe('结束日期 YYYY-MM-DD'),
      }),
      execute: async ({ from, to }) => {
        const start = from ? parseLocalDate(from) : today()
        const end = parseLocalDate(to)
        // 四舍五入以抵消夏令时造成的 1 小时偏差
        const days = Math.round((end.getTime() - start.getTime()) / DAY_MS)
        return { from: formatDate(start), to: formatDate(end), days }
      },
    }),

    shift_date: tool({
      description: '推算某个日期之前或之后若干天的日期',
      inputSchema: z.object({
        date: dateString.optional().describe('基准日期 YYYY-MM-DD，省略时为今天'),
        days: z.number().int().describe('偏移天数，正数为之后，负数为之前'),
      }),
      execute: async ({ date, days }) => {
        const base = date ? parseLocalDate(date) : today()
        const result = new Date(base.getFullYear(), base.getMonth(), base.getDate() + days)
        return { base: formatDate(base), days, result: formatDate(result), weekday: getWeekday(result) }
      },
    }),
  },
}
