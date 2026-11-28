import type { LanguageModel, ModelMessage, ToolSet } from 'ai'
import type { PlanStep } from '@/agent/plan'
import type { AudioRef } from '@/utils/audios'
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
  /** 技能提供的工具，工具名在所有技能之间必须唯一；多个技能可以共用同一个工具对象（如 read_file） */
  tools: ToolSet
}

/**
 * 意图识别结果：区分闲聊与任务（由便宜快速的小模型判断）。是任务时把请求拆成几个步骤，
 * 并选出完成所有步骤需要的技能，工具执行阶段开始时一次加载（执行中仍然可以用 load_skills 加载其他技能）。
 * 读出用户发来的图片后的判断中，task 表示图中是不是要完成的任务
 */
export interface RouteDecision {
  /** 是否需要借助技能完成（获取信息、执行操作等）；false 表示普通闲聊 */
  task: boolean
  /** LLM 给出的判断理由，便于调试 */
  reason: string
  /** 是否是需要查阅较多内容或较多步骤的任务（如了解一个项目），此时允许更多轮的工具调用 */
  complex?: boolean
  /** 拆出的步骤（按顺序），如「转录音频中的语音」「把转录内容翻译成中文」 */
  steps?: string[]
  /** 完成所有步骤需要的技能 id（还没有核对是否存在） */
  skills?: string[]
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
 * 工具执行中向用户提的问题（ask_user），界面上显示为提问卡片
 */
export interface UserQuestion {
  /** 要问用户的问题 */
  question: string
  /** 可供选择的回答；为空时只显示输入框 */
  options?: string[]
  /** 有选项时是否也可以自己输入回答，默认可以 */
  allowCustom?: boolean
  /** 输入框中的提示文字 */
  placeholder?: string
}

/**
 * 由界面提供给技能使用的能力。未提供时，需要授权的操作一律视为被拒绝，也不能向用户提问
 */
export interface SkillHost {
  /** 向用户请求授权，返回是否允许 */
  requestPermission?: (request: PermissionRequest) => Promise<boolean>
  /** 向用户提问并等待回答，返回用户的回答；用户跳过或超时没有回答时返回 null */
  askUser?: (question: UserQuestion) => Promise<string | null>
  /** 把工具产生的图片（如截图）附加到用户的这条消息上，便于展示与追问 */
  attachImages?: (images: ImageRef[]) => void
  /** 把工具读取的音频（如授权文件夹中的音频文件）附加到这一轮的用户消息上，之后追问时可以继续使用 */
  attachAudios?: (audios: AudioRef[]) => void
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
  /** 工具调用的轮数用完时任务还没完成，summary 是根据已有信息做的总结 */
  stepLimitReached?: boolean
  /** 执行计划的最终状态（LLM 用 update_plan 制定过计划时才有） */
  plan?: PlanStep[]
}

/**
 * Agent 运行过程中的事件，用于在界面上展示进度与执行过程。
 * - routing：开始意图识别（区分闲聊与任务）；stage 为 image 时是读出图片后判断图中是不是要完成的任务
 * - routed：意图识别完成
 * - skills-loaded：加载了技能（开始执行时预先加载的，或执行中用 load_skills 加载的），skills 为目前已加载的全部技能
 * - step-start / step-finish：工具执行阶段的一轮 LLM 调用（每轮可以调用若干工具）；
 *   summary 表示轮数用完后，不带工具、根据执行记录做总结的那一次调用
 * - tool-input：模型正在编写工具的参数（如一段代码），chars 为已写的字数；只在开始时带有 toolName
 * - tool-call / tool-result：一次工具调用的开始与结束，用 toolCallId 对应
 * - plan：LLM 制定或更新了执行计划，steps 为最新的完整计划
 */
export type AgentEvent =
  | { type: 'routing', stage?: 'intent' | 'image' }
  | { type: 'routed', decision: RouteDecision }
  | { type: 'skills-loaded', skills: Skill[] }
  | { type: 'step-start', summary?: boolean }
  | { type: 'step-finish', finishReason: string, outputTokens?: number }
  | { type: 'tool-input', toolCallId: string, toolName: string, chars: number }
  | { type: 'tool-call', toolCallId: string, toolName: string, input: unknown }
  | { type: 'tool-result', toolCallId: string, record: ToolCallRecord }
  | { type: 'plan', steps: PlanStep[] }

export interface AgentRunOptions extends SkillHost {
  model: LanguageModel
  /** 用于理解图片的模型，省略时使用 model */
  visionModel?: LanguageModel
  /** 意图识别（区分闲聊与任务）使用的模型，建议用便宜快速的小模型；省略时使用 model */
  routerModel?: LanguageModel
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
