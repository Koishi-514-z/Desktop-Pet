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
    { value: 'minimax', label: 'MiniMax' },
    { value: 'fish-audio', label: 'Fish Audio' },
    { value: 'index-tts', label: 'IndexTTS (本地部署)' },
  ],
  asr: [
    { value: 'openai', label: 'OpenAI 兼容' },
    { value: 'deepgram', label: 'Deepgram' },
    { value: 'elevenlabs', label: 'ElevenLabs' },
    { value: 'dashscope', label: '阿里云百炼（千问）' },
    { value: 'fish-audio', label: 'Fish Audio' },
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

// 添加 provider 时 Base URL 输入框的提示（官方接口地址或本地服务的默认地址）
const BASE_URL_PLACEHOLDERS: Partial<Record<ProviderProtocol, string>> = {
  'index-tts': 'http://127.0.0.1:7861/v1',
  'dashscope': 'https://dashscope.aliyuncs.com',
  // 国际站为 https://api.minimax.io
  'minimax': 'https://api.minimaxi.com',
}

export function getBaseUrlPlaceholder(protocol: ProviderProtocol): string {
  return BASE_URL_PLACEHOLDERS[protocol] ?? 'https://...'
}

export function getProtocolLabel(protocol: ProviderProtocol): string {
  for (const options of Object.values(PROTOCOL_OPTIONS)) {
    const option = options.find((o) => o.value === protocol)
    if (option) return option.label
  }
  return protocol
}

export { getInitial, hashHue } from '@/utils/avatar'
