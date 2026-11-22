import type { ToolExecutionOptions } from 'ai'
import type { SkillContext, ToolDisplay } from '@/agent/types'

/** 在工具的 execute 中获取技能上下文（当前使用的模型等） */
export function getSkillContext(options: ToolExecutionOptions): SkillContext {
  const context = options.experimental_context as SkillContext | undefined
  if (!context?.model) throw new Error('工具缺少运行上下文，只能在 Agent 中调用')
  return context
}

/** 从工具返回值中取出需要展示给用户的结果卡片 */
export function extractDisplay(output: unknown): ToolDisplay | null {
  if (typeof output !== 'object' || output === null || !('display' in output)) return null
  const display = (output as { display: unknown }).display
  if (typeof display !== 'object' || display === null) return null

  const { title, content, format } = display as Partial<ToolDisplay>
  if (typeof title !== 'string' || typeof content !== 'string') return null
  return { title, content, format: format === 'code' ? 'code' : 'text' }
}
