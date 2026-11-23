import type { Skill } from '@/agent/types'
import type { MemoryCategory } from '@/memory/types'
import { tool } from 'ai'
import { z } from 'zod'
import { getSkillContext } from '@/agent/context'
import { formatDate } from '@/agent/utils'
import * as api from '@/memory/api'
import { categoryLabel } from '@/memory/types'
import { useMemoryStore } from '@/stores/memory'

export const MEMORY_SKILL_ID = 'memory'

// 忘掉记忆的权限类型
export const MEMORY_FORGET_PERMISSION = 'memory-forget'

const CATEGORIES = ['profile', 'preference', 'episodic', 'plan', 'relationship'] as const

function describe(memory: { id: number, category: MemoryCategory, content: string, occurredAt: number | null, createdAt: number }) {
  return {
    id: memory.id,
    category: categoryLabel(memory.category),
    content: memory.content,
    date: formatDate(new Date(memory.occurredAt ?? memory.createdAt)),
  }
}

export const memorySkill: Skill = {
  id: MEMORY_SKILL_ID,
  name: '记忆管理',
  description: '查看或删除桌宠的长期记忆：用户问桌宠记得自己哪些事、知道自己什么，或者要求桌宠忘掉某些事。日常对话中桌宠会自动记忆与回忆，不需要这个技能。',
  examples: ['你都记得我哪些事', '你还记得我的生日吗', '把我前任的事忘了吧', '别记着我说过的那件事了'],
  instructions: `- 用户想知道桌宠记得自己哪些事时，调用 list_memories（可以按类别）或 search_memories 查看记忆，然后简要总结。
- 用户要求忘掉某件事时：先用 search_memories 找到相关的记忆，确认哪些记忆确实与用户要忘掉的事有关，再调用 forget_memories，ids 只填写这些记忆的 id，reason 用一句话说明。不要忘掉无关的记忆；没有找到相关的记忆时如实说明。
- 忘掉记忆前会请求用户确认；用户拒绝时不要再次调用。忘掉的记忆可以在设置中撤销。`,
  tools: {
    list_memories: tool({
      description: '列出桌宠记得的关于用户的事（按更新时间从新到旧）',
      inputSchema: z.object({
        category: z.enum(CATEGORIES).optional().describe('只看某一类：profile 用户档案、preference 偏好习惯、relationship 关系印象、plan 计划约定、episodic 情景记忆'),
      }),
      execute: async ({ category }) => {
        const memories = await api.listMemories({ category, limit: 30 })
        return { count: memories.length, memories: memories.map(describe) }
      },
    }),

    search_memories: tool({
      description: '在记忆库中查找与某个话题相关的记忆',
      inputSchema: z.object({
        query: z.string().min(1).describe('要查找的话题，如「前任」「生日」'),
      }),
      execute: async ({ query }) => {
        // 只是查看，不记录访问
        const result = await useMemoryStore().search({ text: query, keywords: query }, { touch: false })
        return { count: result.memories.length, memories: result.memories.map(describe) }
      },
    }),

    forget_memories: tool({
      description: '在用户确认后忘掉指定的记忆（归档，可以在设置中撤销）',
      inputSchema: z.object({
        ids: z.array(z.number().int()).min(1).describe('要忘掉的记忆 id，通过 search_memories 或 list_memories 获取'),
        reason: z.string().min(1).describe('向用户说明为什么忘掉这些记忆，一句话'),
      }),
      execute: async ({ ids, reason }, options) => {
        const context = getSkillContext(options)
        const memories = await api.getMemories(ids)
        if (memories.length === 0) throw new Error('没有找到这些记忆，它们可能已经被忘掉了')

        const allowed = await context.requestPermission?.({
          kind: MEMORY_FORGET_PERMISSION,
          title: `忘掉 ${memories.length} 件事`,
          reason,
          target: memories.map((memory) => `· ${memory.content}`).join('\n'),
          targetLabel: '内容',
          notice: '这些记忆会被移除，可以在 设置 → 记忆 → 最近的变动 中撤销',
          allowAlways: false,
        }) ?? false
        if (!allowed) return { forgotten: 0, message: '用户拒绝了忘掉这些记忆' }

        const count = await api.archiveMemories(memories.map((memory) => memory.id), {
          source: 'skill',
          batch: api.createBatchId('forget-request'),
        })
        useMemoryStore().markChanged()
        return { forgotten: count, memories: memories.map(describe) }
      },
    }),
  },
}
