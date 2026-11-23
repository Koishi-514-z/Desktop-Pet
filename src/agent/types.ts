import type { LanguageModel, ModelMessage, ToolSet } from 'ai'
import type { ImageRef } from '@/utils/images'

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
  /** 也可以是函数，在执行时生成（如写入当前授权访问的文件夹） */
  instructions: string | (() => string)
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

/**
 * 工具执行时可以通过 experimental_context 拿到的上下文，
 * 使用 getSkillContext(options) 获取。例如工具内部需要再调用一次 LLM 时使用其中的 model。
 */
export interface SkillContext extends SkillHost {
  model: LanguageModel
  /** 用于理解图片的模型，未单独配置时与 model 相同 */
  visionModel: LanguageModel
  abortSignal?: AbortSignal
}

/**
 * 涉及隐私或副作用的操作（如截取屏幕）执行前向用户请求的授权
 */
export interface PermissionRequest {
  /** 权限类型，如 screen-capture。用户选择「始终允许」后，同类请求不再询问 */
  kind: string
  /** 简短的标题，如「查看当前窗口」 */
  title: string
  /** 为什么需要这个权限，由 LLM 给出 */
  reason: string
  /** 操作对象，如窗口标题、要忘掉的记忆 */
  target?: string
  /** 操作对象的说明文字，如「窗口」「内容」 */
  targetLabel?: string
  /** 是否提供「始终允许」，默认提供 */
  allowAlways?: boolean
  /** 补充说明，如数据会发送到哪里 */
  notice?: string
  /** 操作对象的展示方式：code 以等宽字体原样展示（保留缩进），适合改动预览 */
  targetFormat?: 'text' | 'code'
}

/**
 * 由界面提供给技能使用的能力。未提供时，需要授权的操作一律视为被拒绝
 */
export interface SkillHost {
  /** 向用户请求授权，返回是否允许 */
  requestPermission?: (request: PermissionRequest) => Promise<boolean>
  /** 把工具产生的图片（如截图）附加到用户的这条消息上，便于展示与追问 */
  attachImages?: (images: ImageRef[]) => void
  /** 更新界面上展示的进度，如「正在查看屏幕…」 */
  setStatus?: (status: string) => void
}

/**
 * 需要完整展示给用户的工具结果（如译文、总结），会以卡片的形式显示在回复下方。
 * 工具在返回值中带上 display 字段即可：`return { display: { title: '翻译', content } }`。
 * 角色扮演阶段的 LLM 不必复述卡片的全文，只需简短地说明或点评。
 */
export interface ToolDisplay {
  title: string
  content: string
  /** code 以等宽字体展示 */
  format?: 'text' | 'code'
}

/**
 * 跳过意图识别与工具执行阶段的 LLM，直接调用某个技能的工具。
 * 用于意图已经明确的场景，如划词工具栏上的按钮。
 */
export interface DirectToolCall {
  skillId: string
  toolName: string
  input: unknown
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
  /** 执行阶段 LLM 对执行过程的客观总结，直接调用工具时为空 */
  summary: string
  /** 需要以卡片形式完整展示给用户的结果 */
  displays: ToolDisplay[]
  /** 执行阶段本身出错（如模型请求失败）时的错误信息 */
  error?: string
}

/** Agent 运行过程中的事件，用于在界面上展示进度 */
export type AgentEvent =
  | { type: 'routing' }
  | { type: 'routed', decision: RouteDecision, skills: Skill[] }
  | { type: 'tool-call', toolName: string, input: unknown }
  | { type: 'tool-result', record: ToolCallRecord }

export interface AgentRunOptions extends SkillHost {
  model: LanguageModel
  /** 用于理解图片的模型，省略时使用 model */
  visionModel?: LanguageModel
  /** 对话上下文（不含系统提示词），最后一条应为用户的最新消息 */
  messages: ModelMessage[]
  /** 本次可用的技能 */
  skills: Skill[]
  /** 直接调用指定工具，跳过意图识别与工具执行阶段的 LLM */
  directCall?: DirectToolCall
  /**
   * 提供给工具执行阶段的背景信息（如从长期记忆中检索到的用户信息）。
   * 可以传入 Promise：工具执行阶段开始前才会等待它，因此可以与意图识别并行准备
   */
  background?: string | Promise<string>
  onEvent?: (event: AgentEvent) => void
  abortSignal?: AbortSignal
}
