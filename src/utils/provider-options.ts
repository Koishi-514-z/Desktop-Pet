import type { ProviderCategory, ProviderProtocol } from '@/stores/providers'

export interface ProtocolOption {
  value: ProviderProtocol
  label: string
}

// 各类 provider 可选的协议
export const PROTOCOL_OPTIONS: Record<ProviderCategory, ProtocolOption[]> = {
  llm: [
    { value: 'openai', label: 'OpenAI 兼容' },
    { value: 'anthropic', label: 'Anthropic' },
    { value: 'google', label: 'Google' },
  ],
  tts: [
    { value: 'openai', label: 'OpenAI 兼容' },
    { value: 'elevenlabs', label: 'ElevenLabs' },
    { value: 'lmnt', label: 'LMNT' },
    { value: 'hume', label: 'Hume' },
    { value: 'deepgram', label: 'Deepgram' },
    { value: 'dashscope', label: '阿里云百炼（千问）' },
    { value: 'index-tts', label: 'IndexTTS (本地部署)' },
  ],
  asr: [
    { value: 'openai', label: 'OpenAI 兼容' },
    { value: 'deepgram', label: 'Deepgram' },
    { value: 'elevenlabs', label: 'ElevenLabs' },
    { value: 'dashscope', label: '阿里云百炼（千问）' },
  ],
}

export const CATEGORY_LABELS: Record<ProviderCategory, string> = {
  llm: 'LLM',
  tts: '语音合成 (TTS)',
  asr: '语音识别 (ASR)',
}

// 「添加 xxx Provider」按钮上的简称
export const CATEGORY_SHORT_LABELS: Record<ProviderCategory, string> = {
  llm: 'LLM',
  tts: 'TTS',
  asr: 'ASR',
}

export function getProtocolLabel(protocol: ProviderProtocol): string {
  for (const options of Object.values(PROTOCOL_OPTIONS)) {
    const option = options.find((o) => o.value === protocol)
    if (option) return option.label
  }
  return protocol
}

export { getInitial, hashHue } from '@/utils/avatar'
