import type { ToolExecutionOptions } from 'ai'
import type { Skill, ToolDisplay } from '@/agent/types'
import type { StoredAudio, Transcript } from '@/utils/audios'
import { tool } from 'ai'
import { z } from 'zod'
import { getSkillContext } from '@/agent/context'
import { errorMessage } from '@/agent/utils'
import { analyzeTranscript, listenToAudio } from '@/audio/analyze'
import { clipWav, decodeAudio, formatTranscript, MAX_DURATION_SECONDS, SAMPLE_RATE, transcribeSamples } from '@/audio/transcribe'
import { readFileBytes } from '@/files/api'
import { useAgentStore } from '@/stores/agent'
import { useToolsStore } from '@/stores/tools'
import { useTranscriptionStore } from '@/stores/transcription'
import { addAudio, AUDIO_SKILL_ID, findLatestAudioIds, formatDuration, loadAudio, MAX_AUDIO_BYTES, saveTranscript } from '@/utils/audios'

export { AUDIO_SKILL_ID }

/** 直接交给模型「听」的音频最长多少秒（太长时只取开头） */
export const LISTEN_MAX_SECONDS = 5 * 60
/** 转录结果交给执行模块的预览长度（完整的转录稿以卡片展示给用户） */
const PREVIEW_LENGTH = 3000

const MEDIA_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm', weba: 'audio/webm', amr: 'audio/amr',
}

const sourceParams = {
  audioId: z.string().optional().describe('要处理的音频 id（消息中【附音频：id｜…】里的 id）。处理用户最近发送的音频时省略'),
  path: z.string().optional().describe('授权文件夹中音频文件的完整路径；用户给出了文件路径、而不是在对话中发送音频时使用'),
}

function describeAudio(audio: StoredAudio) {
  return { audioId: audio.id, name: audio.name, ...(audio.duration ? { duration: formatDuration(audio.duration) } : {}) }
}

/** 找到要处理的音频：授权文件夹中的文件（读取后附加到这一轮的消息上），或对话中发送的音频 */
async function resolveAudio(options: ToolExecutionOptions, input: { audioId?: string, path?: string }): Promise<StoredAudio> {
  const context = getSkillContext(options)
  if (input.path) {
    const store = useToolsStore()
    const path = store.resolvePath(input.path)
    context.setStatus?.('正在读取音频文件…')
    const bytes = await readFileBytes(store.rootPaths, path, MAX_AUDIO_BYTES)
    const name = path.split(/[\\/]/).pop() || '音频'
    const extension = name.split('.').pop()?.toLowerCase() ?? ''
    const ref = await addAudio(new Blob([bytes as BlobPart], { type: MEDIA_TYPES[extension] ?? '' }), name)
    context.attachAudios?.([ref])
    return (await loadAudio(ref.id))!
  }
  const id = input.audioId || findLatestAudioIds(options.messages)[0]
  if (!id) throw new Error('对话中还没有音频：请把音频文件拖进对话框（或点「添加附件」），也可以告诉我它在授权文件夹中的路径')
  const audio = await loadAudio(id)
  if (!audio) throw new Error(`找不到音频 ${id}，它可能已经被删除`)
  return audio
}

async function decode(audio: StoredAudio, options: ToolExecutionOptions): Promise<Float32Array> {
  if (audio.duration > MAX_DURATION_SECONDS) {
    throw new Error(`音频太长（${formatDuration(audio.duration)}），最长支持 ${formatDuration(MAX_DURATION_SECONDS)}，可以先剪成几段`)
  }
  getSkillContext(options).setStatus?.('正在解码音频…')
  return decodeAudio(audio.data)
}

/** 转录结果：转录过的直接使用，否则转录并保存 */
async function ensureTranscript(audio: StoredAudio, options: ToolExecutionOptions): Promise<Transcript> {
  if (audio.transcript) return audio.transcript
  const context = getSkillContext(options)
  const samples = await decode(audio, options)
  const transcriptionStore = useTranscriptionStore()
  const result = await transcribeSamples(samples, {
    transcribe: (wav, signal) => transcriptionStore.transcribeClip(wav, signal),
    signal: context.abortSignal,
    onProgress: (done, total) => context.setStatus?.(total > 1 ? `正在转录 ${done}/${total}（每段约一分钟）…` : '正在转录…'),
  })
  await saveTranscript(audio.id, result)
  return result
}

const TASK_TITLES = { summary: '音频总结', minutes: '会议纪要', question: '关于音频的回答' } as const

export const audioSkill: Skill = {
  id: AUDIO_SKILL_ID,
  name: '音频理解',
  description: '处理用户发送的音频文件（消息中带有【附音频：…】），或者授权文件夹中的音频文件：把说的话转成文字（带时间点），总结内容、整理会议纪要、回答关于音频内容的问题，以及分析声音本身（音乐、环境声、说话人的语气情绪、有几个人在说话等）。',
  examples: ['把这段录音转成文字', '帮我总结一下这个会议录音', '整理一份会议纪要', '录音里有没有提到截止时间', '这段音乐是什么风格', '这段录音里说话的人情绪怎么样'],
  instructions: `- 用户发送的音频以「【附音频：id｜文件名｜时长】」的形式附在用户消息末尾。处理用户最近发送的音频时省略 audioId；处理更早的音频时填写对应的 id。用户给出的是授权文件夹中的文件路径时，填写 path。
- 按用户的要求选择工具：
  - 要文字稿（「转成文字」「逐字稿」）用 transcribe_audio，完整的转录稿会以卡片展示给用户；
  - 关于说话内容的总结、会议纪要、提问用 analyze_speech（task 分别为 summary、minutes、question，用户的具体问题或要求填入 question）；它会自动转录，不需要先调用 transcribe_audio；
  - 关于声音本身的问题（音乐的风格与情绪、背景里有什么声音、说话人的语气情绪、有几个人在说话、录音质量）用 listen_to_audio，只会听开头 ${LISTEN_MAX_SECONDS / 60} 分钟。
- 用户只发送了音频、没有说明要做什么时：是说话的录音就用 analyze_speech 总结（task 为 summary），转不出文字时再用 listen_to_audio 听听是什么声音。
- 转录需要先配置语音识别服务（设置 → Provider）；listen_to_audio 需要能接收音频的模型（如 Gemini、gpt-4o-audio、Qwen-Omni），可以在 设置 → Skills 中为音频理解单独选择。出错时把原因如实告诉用户。
- 同一个音频转录一次后会保存结果，之后的追问不会重新转录。
- 对话中没有音频、用户也没有给出路径时，不要调用工具，说明需要先发送音频文件。
- 工具结果会以卡片形式完整展示给用户，总结时简单概括结果即可，不需要复述全文。`,
  tools: {
    transcribe_audio: tool({
      description: '把音频中说的话转成带时间点的文字稿',
      inputSchema: z.object(sourceParams),
      execute: async (input, options) => {
        const audio = await resolveAudio(options, input)
        const transcript = await ensureTranscript(audio, options)
        const text = formatTranscript(transcript.segments)
        if (!text) return { ...describeAudio(audio), transcribed: false, message: '没有识别出说话的内容：可能是音乐或环境声，可以用 listen_to_audio 听听是什么声音' }
        const display: ToolDisplay = { title: `转录：${audio.name}`, content: text, format: 'text' }
        return {
          ...describeAudio(audio),
          transcribed: true,
          sentences: transcript.segments.length,
          preview: text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}\n……（完整的转录稿已展示给用户）` : text,
          display,
        }
      },
    }),

    analyze_speech: tool({
      description: '根据音频中说的话总结内容、整理会议纪要，或回答关于说话内容的问题（会自动转录）',
      inputSchema: z.object({
        ...sourceParams,
        task: z.enum(['summary', 'minutes', 'question']).describe('summary：总结内容；minutes：整理会议纪要；question：回答问题'),
        question: z.string().optional().describe('用户的问题或补充要求，如「有没有提到截止时间」「重点写技术方案」'),
      }),
      execute: async ({ task, question, ...source }, options) => {
        const context = getSkillContext(options)
        const audio = await resolveAudio(options, source)
        const transcript = await ensureTranscript(audio, options)
        const text = formatTranscript(transcript.segments)
        if (!text) return { ...describeAudio(audio), done: false, message: '没有识别出说话的内容：可能是音乐或环境声，可以用 listen_to_audio 听听是什么声音' }

        context.setStatus?.('正在分析内容…')
        const output = await analyzeTranscript({
          model: context.model,
          transcript: text,
          task,
          question,
          context: `${audio.name}${audio.duration ? `，时长 ${formatDuration(audio.duration)}` : ''}`,
          abortSignal: context.abortSignal,
          onProgress: (status) => context.setStatus?.(status),
        })
        const display: ToolDisplay = { title: `${TASK_TITLES[task]}：${audio.name}`, content: output, format: 'text' }
        return { ...describeAudio(audio), done: true, display }
      },
    }),

    listen_to_audio: tool({
      description: `把音频直接交给能听声音的模型，分析声音本身：音乐、环境声、说话人的语气与情绪、有几个人在说话、录音质量等（只听开头 ${LISTEN_MAX_SECONDS / 60} 分钟）`,
      inputSchema: z.object({
        ...sourceParams,
        question: z.string().min(1).describe('要从声音中弄明白什么，尽量包含用户的原话'),
      }),
      execute: async ({ question, ...source }, options) => {
        const context = getSkillContext(options)
        const audio = await resolveAudio(options, source)
        const samples = await decode(audio, options)
        const { wav, seconds, truncated } = clipWav(samples, LISTEN_MAX_SECONDS)
        if (seconds * SAMPLE_RATE < SAMPLE_RATE / 10) throw new Error('音频是空的')

        context.setStatus?.('正在听…')
        const model = useAgentStore().resolveAudioModel() ?? context.model
        let output: string
        try {
          output = await listenToAudio({
            model,
            wav,
            question,
            context: `${audio.name}${truncated ? `（只截取了开头 ${formatDuration(seconds)}，全长 ${formatDuration(samples.length / SAMPLE_RATE)}）` : ''}`,
            abortSignal: context.abortSignal,
          })
        }
        catch (error) {
          if (context.abortSignal?.aborted) throw error
          throw new Error(`${errorMessage(error)}（如果当前模型不能接收音频，请在 设置 → Skills 中为音频理解选择一个能听音频的模型，如 Gemini、gpt-4o-audio、Qwen-Omni）`)
        }
        if (!output) throw new Error('模型没有返回任何内容')
        const display: ToolDisplay = { title: `声音分析：${audio.name}`, content: output, format: 'text' }
        return { ...describeAudio(audio), listenedSeconds: Math.round(seconds), truncated, display }
      },
    }),
  },
}
