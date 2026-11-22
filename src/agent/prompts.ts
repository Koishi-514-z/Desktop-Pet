import type { ModelMessage } from 'ai'
import type { AgentResult, Skill } from '@/agent/types'
import { describeTimezone, formatDateTime, messageText, stringify, truncate } from '@/agent/utils'

// ===== 阶段一：意图识别 =====

export function buildRouterSystemPrompt(skills: Skill[]): string {
  const catalog = skills
    .map((skill) => {
      const examples = skill.examples?.length ? `例如：${skill.examples.map((e) => `「${e}」`).join('')}` : ''
      return `- ${skill.id}（${skill.name}）：${skill.description}${examples}`
    })
    .join('\n')

  return `你是一个意图识别器，负责判断用户的最新消息是否需要借助下列技能来完成。

# 可用技能
${catalog}

# 判断规则
- 只有当用户的请求确实需要技能提供的能力（获取实时信息、执行操作等）时才选择技能；闲聊、情感交流、常识问答、关于桌宠本身的提问都不需要技能。
- 结合最近的对话理解省略和指代。例如上一轮在聊北京的天气，用户接着问「那明天呢」，仍然需要天气相关的技能。
- 一条消息可能同时需要多个技能；拿不准时宁可不选。
- 只能使用上面列出的技能 id。

# 输出格式
只输出一个 JSON 对象，不要输出任何其他内容：
{"skills": ["技能 id"], "reason": "一句话理由"}
不需要技能时输出：{"skills": [], "reason": "一句话理由"}`
}

/** 将对话上下文压缩成一段文本交给意图识别器，避免角色设定干扰判断 */
export function buildRouterPrompt(messages: ModelMessage[]): string {
  const history = messages.slice(0, -1)
  const latest = messages[messages.length - 1]

  const lines = history.map((message) => {
    const speaker = message.role === 'user' ? '用户' : '桌宠'
    return `${speaker}：${truncate(messageText(message), 300)}`
  })

  return `# 最近的对话
${lines.length ? lines.join('\n') : '（无）'}

# 用户的最新消息
${latest ? messageText(latest) : ''}`
}

// ===== 阶段二：工具执行 =====

export function buildExecutorSystemPrompt(skills: Skill[], now = new Date()): string {
  const skillSections = skills
    .map((skill) => `## ${skill.name}（${skill.id}）\n${skill.instructions.trim()}`)
    .join('\n\n')

  return `你是桌宠的「工具执行模块」，负责调用工具完成用户的请求。你的输出不会直接展示给用户，而是交给负责角色扮演的模块整理后再回复，所以请保持客观、简洁，不需要寒暄或扮演角色。

# 当前时间
${formatDateTime(now)}，时区 ${describeTimezone(now)}

# 已激活的技能
${skillSections}

# 执行要求
- 根据用户的最新消息（结合对话上下文）调用合适的工具，必要时可以多次调用或调用多个工具。
- 参数缺失且无法从上下文推断时，不要猜测，直接说明还缺少什么信息。
- 工具调用失败时，可以修正参数后重试一次；仍然失败就如实说明。
- 不要编造工具没有返回的数据。
- 完成后用几句话总结：做了什么、得到了什么结果、是否有失败及原因、还需要用户补充什么。`
}

// ===== 阶段三：角色润色 =====

/** 将工具执行结果整理成一段系统提示，附加在人设提示词之后，供角色扮演阶段的 LLM 参考 */
export function buildAgentContextPrompt(result: AgentResult): string {
  const skillNames = result.skills.map((skill) => skill.name).join('、')

  const calls = result.toolCalls.length
    ? result.toolCalls
        .map((call, index) => {
          const outcome = call.error !== undefined ? `失败：${call.error}` : `结果：${stringify(call.output)}`
          return `${index + 1}. ${call.toolName}\n   参数：${stringify(call.input, 500)}\n   ${outcome}`
        })
        .join('\n')
    : '（没有调用任何工具）'

  const summary = result.error !== undefined
    ? `执行过程出错：${result.error}`
    : result.summary.trim() || '（无）'

  return `# 本轮技能执行结果

为了回应用户的最新消息，你刚刚使用了技能：${skillNames}。以下是执行记录，只有你能看到，用户看不到：

## 工具调用
${calls}

## 执行总结
${summary}

## 回复要求
- 以上结果真实可信，回答必须以此为准，不要编造结果之外的信息。
- 如果执行失败或还缺少信息，用符合你性格的方式告诉用户，并说明需要什么。
- 挑用户关心的重点，用口语自然地说出来，不要照搬原始数据或 JSON，也不要提到「工具」「函数」「技能」「执行记录」这类字眼，就像这些事是你自己做到的一样。
- 仍然遵守前面的回复格式与情绪标签要求。`
}

/** 系统事件（如提醒到时）以一条隐藏的用户消息告知角色扮演阶段的 LLM */
export function buildEventMessage(event: string): string {
  return `【系统通知，并非用户发言】${event}\n请以你的口吻主动对用户说话，不要提及「系统通知」。`
}
