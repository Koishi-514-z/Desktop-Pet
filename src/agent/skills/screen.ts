import type { Skill } from '@/agent/types'
import { tool } from 'ai'
import { z } from 'zod'
import { getSkillContext } from '@/agent/context'
import { PLAIN_TEXT, runVisionTask } from '@/agent/skills/image'
import { addImage } from '@/utils/images'
import { captureWindow, getTargetWindow } from '@/utils/screen'

export const SCREEN_SKILL_ID = 'screen'

// 截取屏幕的权限类型，用户选择「始终允许」后不再询问
export const SCREEN_CAPTURE_PERMISSION = 'screen-capture'

export const screenSkill: Skill = {
  id: SCREEN_SKILL_ID,
  name: '看屏幕',
  description: '用户的问题需要看到他屏幕上正在使用的窗口才能回答，而对话中没有相关的文字或图片时使用，例如程序运行出错、窗口里的内容看不懂，以及其他需要看屏幕才能回答的问题。会先请求用户授权，再截取用户当前使用的窗口进行分析。用户已经发送了图片时不需要这个技能。',
  examples: ['帮我看看屏幕上这个报错', '这个窗口里的选项是什么意思', '猜猜我在干什么', '我该点哪里'],
  instructions: `- 只有当回答确实依赖用户屏幕上的内容、而对话中没有足够的文字或图片时，才调用 look_at_screen；能直接回答或用户已经贴出了报错内容时不要调用。
- reason 用一句话向用户说明为什么需要看屏幕，会显示在授权请求中，例如「看看我在干什么」「看看程序报了什么错」。
- question 写清楚要从截图中弄明白什么，尽量包含用户的原话与已知的背景。
- 只能截取用户最近使用的那一个窗口（不包括桌宠自己），截图前会请求用户授权。
- 用户拒绝授权时不要再次调用，说明可以改为把文字复制过来或发送截图。
- 工具结果会以卡片形式完整展示给用户，总结时简单概括结果即可，不需要复述全文。`,
  tools: {
    look_at_screen: tool({
      description: '在用户授权后截取用户当前使用的窗口，并根据截图回答问题',
      inputSchema: z.object({
        reason: z.string().min(1).describe('向用户说明为什么需要看屏幕，一句话'),
        question: z.string().min(1).describe('要从截图中弄明白的问题'),
      }),
      execute: async ({ reason, question }, options) => {
        const context = getSkillContext(options)

        const target = await getTargetWindow()
        if (!target) throw new Error('没有找到可以查看的窗口：用户可能还没有打开其他程序，或者窗口都已最小化')
        const windowName = target.appName && !target.title.includes(target.appName)
          ? `${target.title}（${target.appName}）`
          : target.title

        context.setStatus?.('等待你的授权…')
        const allowed = await context.requestPermission?.({
          kind: SCREEN_CAPTURE_PERMISSION,
          title: '查看当前窗口',
          reason,
          target: windowName,
          targetLabel: '窗口',
          notice: '截图会显示在对话中，并发送给识图模型分析',
        }) ?? false
        if (!allowed) {
          return { allowed: false, window: windowName, message: '用户拒绝了查看屏幕的请求，没有截图' }
        }

        context.setStatus?.('正在查看屏幕…')
        const image = await addImage(await captureWindow(target.id))
        context.attachImages?.([image])

        const { display } = await runVisionTask(options, [image.id], {
          title: '屏幕分析',
          system: `你擅长根据屏幕截图帮用户解决电脑使用与编程中的问题。${PLAIN_TEXT}`,
          prompt: `这是用户当前窗口「${windowName}」的截图。
用户的问题：${question}

请结合截图回答：
1. 先说明截图中与问题相关的关键信息，涉及报错时原样摘录错误信息
2. 再回答问题，分析原因
3. 最后给出具体可操作的解决步骤，涉及命令或代码时原样写出
截图中看不出来的就如实说明，并告诉用户还需要提供什么。`,
        })

        return { allowed: true, window: windowName, imageId: image.id, display }
      },
    }),
  },
}
