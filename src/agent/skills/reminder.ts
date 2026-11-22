import type { Skill } from '@/agent/types'
import type { Reminder } from '@/stores/reminders'
import { tool } from 'ai'
import { z } from 'zod'
import { formatDateTime, formatDuration } from '@/agent/utils'
import { useRemindersStore } from '@/stores/reminders'

/** 解析本地时间 YYYY-MM-DDTHH:mm[:ss]（也接受空格分隔） */
function parseLocalDateTime(text: string): number {
  const match = text.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (!match) throw new Error(`无法识别的时间：${text}，格式应为 YYYY-MM-DDTHH:mm`)
  const [year, month, day, hour, minute, second] = match.slice(1).map((v) => Number(v ?? 0)) as [number, number, number, number, number, number]
  return new Date(year, month - 1, day, hour, minute, second).getTime()
}

function describe(reminder: Reminder) {
  return {
    id: reminder.id,
    message: reminder.message,
    dueAt: formatDateTime(new Date(reminder.dueAt)),
    remaining: formatDuration(reminder.dueAt - Date.now()),
  }
}

export const reminderSkill: Skill = {
  id: 'reminder',
  name: '提醒',
  description: '设置定时提醒或倒计时（到时间后桌宠会主动提醒用户），查看或取消已设置的提醒。',
  examples: ['十分钟后提醒我喝水', '明天早上8点叫我起床', '我设了哪些提醒', '取消喝水的提醒'],
  instructions: `- 设置提醒调用 create_reminder：相对时间（如「十分钟后」）用 delaySeconds，具体时刻（如「下午三点」）用 at，二者只填一个；at 需要结合当前时间换算成完整的本地时间。
- 用户没说具体事情时，message 写「时间到了」。时间不明确（如「待会儿」）时不要猜测，说明需要用户给出具体时间。
- 查看提醒调用 list_reminders。
- 取消提醒需要 id：先调用 list_reminders 找到对应的提醒，再调用 cancel_reminder。`,
  tools: {
    create_reminder: tool({
      description: '创建一个提醒，到时间后桌宠会主动提醒用户',
      inputSchema: z.object({
        message: z.string().min(1).describe('提醒内容，如「喝水」'),
        delaySeconds: z.number().positive().optional().describe('多少秒后提醒，用于相对时间'),
        at: z.string().optional().describe('提醒的本地时间，格式 YYYY-MM-DDTHH:mm，用于具体时刻'),
      }),
      execute: async ({ message, delaySeconds, at }) => {
        if ((delaySeconds === undefined) === (at === undefined)) {
          throw new Error('delaySeconds 与 at 必须且只能填写一个')
        }
        const dueAt = delaySeconds !== undefined ? Date.now() + delaySeconds * 1000 : parseLocalDateTime(at!)
        if (dueAt <= Date.now()) {
          throw new Error(`提醒时间 ${formatDateTime(new Date(dueAt))} 已经过去了`)
        }
        return { created: describe(useRemindersStore().addReminder(message, dueAt)) }
      },
    }),

    list_reminders: tool({
      description: '列出所有尚未到期的提醒',
      inputSchema: z.object({}),
      execute: async () => {
        const reminders = useRemindersStore().reminders.map(describe)
        return { count: reminders.length, reminders }
      },
    }),

    cancel_reminder: tool({
      description: '根据 id 取消一个提醒',
      inputSchema: z.object({
        id: z.string().describe('提醒的 id，可通过 list_reminders 获取'),
      }),
      execute: async ({ id }) => {
        const reminder = useRemindersStore().cancelReminder(id)
        if (!reminder) throw new Error(`没有找到 id 为 ${id} 的提醒`)
        return { cancelled: describe(reminder) }
      },
    }),
  },
}
