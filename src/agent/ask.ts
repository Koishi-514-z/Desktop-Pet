import { tool } from 'ai'
import { z } from 'zod'
import { getSkillContext } from '@/agent/context'
import { truncate } from '@/agent/utils'

/**
 * 执行中途向用户提问：遇到必须由用户决定、又无法从上下文推断的问题时（如用哪个端口、改哪一份文件），
 * LLM 调用 ask_user，界面上显示提问卡片（选项按钮或输入框），用户回答后在同一次执行里继续往下做，
 * 不必结束执行、在回复里问用户、下一轮再从头来。
 */

/** 向用户提问的工具名 */
export const ASK_USER_TOOL = 'ask_user'

// 选项的数量上限
const MAX_OPTIONS = 6
// 执行过程中显示的问题与回答的长度
const SUMMARY_LENGTH = 60

export function createAskUserTool() {
  return tool({
    description: '向用户提问并等待回答：执行中遇到必须由用户决定、又无法从上下文推断的问题时使用。界面上会显示提问卡片（选项按钮或输入框），用户回答后继续执行',
    inputSchema: z.object({
      question: z.string().min(1).describe('要问用户的问题：一句话说清楚需要用户决定什么'),
      options: z.array(z.string().min(1)).min(2).max(MAX_OPTIONS).optional()
        .describe(`可供选择的回答（2～${MAX_OPTIONS} 个，每个都简短）。能列出可能的回答时尽量列出，用户点一下就能回答`),
      allowCustom: z.boolean().optional().describe('有选项时是否也允许用户自己输入回答，默认允许'),
      placeholder: z.string().optional().describe('输入框中的提示文字，如「例如：8080」'),
    }),
    execute: async ({ question, options, allowCustom, placeholder }, toolOptions) => {
      const context = getSkillContext(toolOptions)
      if (!context.askUser) throw new Error('现在无法向用户提问。请根据已知信息继续，或者在总结中说明还需要用户补充什么')

      context.setStatus?.('正在等待你的回答')
      const answer = await context.askUser({
        question,
        ...(options?.length ? { options } : {}),
        ...(allowCustom !== undefined ? { allowCustom } : {}),
        ...(placeholder ? { placeholder } : {}),
      })
      if (answer === null) {
        return {
          answered: false,
          note: '用户没有回答（跳过或超时）。不要再问同样的问题：能按合理的默认做法继续的就继续，并在总结中说明用了什么做法；否则结束执行，说明还缺少什么信息',
        }
      }
      return { answered: true, answer }
    },
  })
}

/** 执行过程中显示的摘要：「问：用哪个端口？」 */
export function describeQuestion(input: unknown): string | undefined {
  const question = (input as { question?: unknown } | null)?.question
  return typeof question === 'string' ? `问：${truncate(question, SUMMARY_LENGTH)}` : undefined
}

/** 回答之后的摘要：「问：用哪个端口？ → 答：8080」，没有回答时标出 */
export function describeAnswer(input: unknown, output: unknown): string | undefined {
  const asked = describeQuestion(input)
  if (!asked) return undefined
  const result = output as { answered?: unknown, answer?: unknown } | null
  if (result?.answered === true && typeof result.answer === 'string') return `${asked} → 答：${truncate(result.answer, SUMMARY_LENGTH)}`
  if (result?.answered === false) return `${asked} → 没有回答`
  return asked
}
