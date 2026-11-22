import type { LanguageModel, ModelMessage, ToolSet } from 'ai'

/**
 * Skill（技能）：面向同一类用户意图的一组能力，由「使用说明 + 工具」组成。
 *
 * 采用渐进式披露：
 * - 意图识别阶段只能看到 id / name / description / examples，用于判断是否需要该技能；
 * - 技能被选中后，instructions 与 tools 才会交给工具执行阶段的 LLM。
 *
 * 新增技能：在 skills/ 下实现一个 Skill 对象，并在 skills/index.ts 中注册即可。
 */
export interface Skill {
  /** 唯一标识，仅使用小写字母、数字、下划线，意图识别阶段的 LLM 会输出它 */
  id: string
  /** 展示给用户的名称 */
  name: string
  /** 技能能处理哪些请求，供意图识别使用，越具体越好 */
  description: string
  /** 典型的用户说法，帮助意图识别 */
  examples?: string[]
  /** 技能被激活后注入给工具执行阶段 LLM 的使用说明 */
  instructions: string
  /** 技能提供的工具，工具名在所有技能之间必须唯一 */
  tools: ToolSet
}

/** 意图识别结果 */
export interface RouteDecision {
  /** 需要激活的技能 id，为空表示普通闲聊，无需调用工具 */
  skillIds: string[]
  /** LLM 给出的判断理由，便于调试 */
  reason: string
}

/** 一次工具调用的记录 */
export interface ToolCallRecord {
  toolName: string
  input: unknown
  /** 调用成功时的返回值 */
  output?: unknown
  /** 调用失败时的错误信息 */
  error?: string
}

/** 工具执行阶段的结果，会交给角色扮演阶段的 LLM 润色成最终回复 */
export interface AgentResult {
  /** 被激活的技能 */
  skills: Skill[]
  /** 按发生顺序排列的工具调用记录 */
  toolCalls: ToolCallRecord[]
  /** 执行阶段 LLM 对执行过程的客观总结 */
  summary: string
  /** 执行阶段本身出错（如模型请求失败）时的错误信息 */
  error?: string
}

/** Agent 运行过程中的事件，用于在界面上展示进度 */
export type AgentEvent =
  | { type: 'routing' }
  | { type: 'routed', decision: RouteDecision, skills: Skill[] }
  | { type: 'tool-call', toolName: string, input: unknown }
  | { type: 'tool-result', record: ToolCallRecord }

export interface AgentRunOptions {
  model: LanguageModel
  /** 对话上下文（不含系统提示词），最后一条应为用户的最新消息 */
  messages: ModelMessage[]
  /** 本次可用的技能 */
  skills: Skill[]
  onEvent?: (event: AgentEvent) => void
  abortSignal?: AbortSignal
}
