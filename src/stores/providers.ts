import { computed, onMounted, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useLocalStorage } from '@vueuse/core'
import { del, get, post } from '@/utils/web'
import { dashscopeCompatibleUrl, dashscopeModels } from '@/utils/dashscope'
import { FISH_AUDIO_ASR_MODELS, FISH_AUDIO_TTS_MODELS, listFishAudioVoices, validateFishAudio } from '@/utils/fish-audio'
import { listMiniMaxVoices, MINIMAX_TTS_MODELS, validateMiniMax } from '@/utils/minimax'

export type ProviderCategory = 'llm' | 'tts' | 'asr'

// provider 所使用的 API 协议，决定 ChatStore / SpeechStore / TranscriptionStore 中使用哪个 AI SDK 适配器与其通信
export type ProviderProtocol = 'openai' | 'anthropic' | 'google' | 'elevenlabs' | 'lmnt' | 'hume' | 'deepgram' | 'index-tts' | 'dashscope' | 'minimax' | 'fish-audio'

// 不需要配置 baseUrl 的协议（使用固定的官方接口地址）
const PROTOCOLS_WITHOUT_BASE_URL: ProviderProtocol[] = ['elevenlabs', 'lmnt', 'hume', 'deepgram', 'fish-audio']

export function protocolRequiresBaseUrl(protocol: ProviderProtocol): boolean {
  return !PROTOCOLS_WITHOUT_BASE_URL.includes(protocol)
}

// apiKey 可选的协议（本地部署的服务通常不需要鉴权）
const PROTOCOLS_WITH_OPTIONAL_API_KEY: ProviderProtocol[] = ['index-tts']

export function protocolRequiresApiKey(protocol: ProviderProtocol): boolean {
  return !PROTOCOLS_WITH_OPTIONAL_API_KEY.includes(protocol)
}

export interface ProviderModel {
  id: string
  name: string
  description?: string
}

// TTS provider 提供的声线（voice）
export interface ProviderVoice {
  id: string
  name: string
  description?: string
}

export interface Provider {
  id: string
  name: string
  category: ProviderCategory
  protocol: ProviderProtocol
  baseUrl: string
  apiKey: string
  description?: string
  models: ProviderModel[]
  selectedModelId: string
  isValid: boolean
  validator: () => Promise<boolean>
  listModels: () => Promise<ProviderModel[]>
  // category 为 tts 时使用
  voices?: ProviderVoice[]
  selectedVoiceId?: string
  listVoices?: () => Promise<ProviderVoice[]>
  // 支持自定义音色的 TTS provider 使用（如 index-tts）：上传音色参考音频 / 删除音色
  uploadVoice?: (file: Blob, name: string, options?: { overwrite?: boolean }) => Promise<ProviderVoice>
  deleteVoice?: (voiceId: string) => Promise<void>
}

// 由协议决定的 provider 方法，不会被持久化，需要在加载后重新挂载
export type ProviderHandlers = Pick<Provider, 'validator' | 'listModels' | 'listVoices' | 'uploadVoice' | 'deleteVoice'>
type ProviderHandlerKey = keyof ProviderHandlers

// 缓存有效期：24 小时
const PROVIDER_INFO_CACHE_TTL = 1000 * 60 * 60 * 24

// 缓存的 provider 加载结果
export interface ProviderInfoCache {
  id: string
  // 由 protocol + baseUrl + apiKey 组成，用于判断凭据是否变化
  key: string
  timestamp: number
  models: ProviderModel[]
  voices?: ProviderVoice[]
  isValid: boolean
}

function createProviderId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `provider-${Math.random().toString(36).slice(2)}`
}

function getProviderCacheKey(provider: Pick<Provider, 'protocol' | 'baseUrl' | 'apiKey'>): string {
  return `${provider.protocol}::${provider.baseUrl}::${provider.apiKey}`
}

// 根据已加载的 models 修正 selectedModelId
function applyModelDefaults(provider: Provider) {
  if (provider.models.length === 0) {
    provider.selectedModelId = ''
    return
  }

  if (!provider.selectedModelId || !provider.models.some((m) => m.id === provider.selectedModelId))
    provider.selectedModelId = provider.models[0]!.id
}

// 根据已加载的 voices 修正 selectedVoice
function applyVoiceDefaults(provider: Provider) {
  if (!provider.voices || provider.voices.length === 0) return

  if (!provider.selectedVoiceId || !provider.voices.some((v) => v.id === provider.selectedVoiceId))
    provider.selectedVoiceId = provider.voices[0]!.id
}

// OpenAI 语音合成接口提供的固定声线列表
const OPENAI_TTS_VOICES: ProviderVoice[] = [
  { id: 'alloy', name: 'Alloy' },
  { id: 'ash', name: 'Ash' },
  { id: 'ballad', name: 'Ballad' },
  { id: 'coral', name: 'Coral' },
  { id: 'echo', name: 'Echo' },
  { id: 'fable', name: 'Fable' },
  { id: 'nova', name: 'Nova' },
  { id: 'onyx', name: 'Onyx' },
  { id: 'sage', name: 'Sage' },
  { id: 'shimmer', name: 'Shimmer' },
  { id: 'verse', name: 'Verse' },
]

// ElevenLabs 语音合成接口提供的固定模型列表（ElevenLabsSpeechModelId）
const ELEVENLABS_TTS_MODELS: ProviderModel[] = [
  { id: 'eleven_v3', name: 'Eleven v3' },
  { id: 'eleven_multilingual_v2', name: 'Eleven Multilingual v2' },
  { id: 'eleven_flash_v2_5', name: 'Eleven Flash v2.5' },
  { id: 'eleven_flash_v2', name: 'Eleven Flash v2' },
  { id: 'eleven_turbo_v2_5', name: 'Eleven Turbo v2.5' },
  { id: 'eleven_turbo_v2', name: 'Eleven Turbo v2' },
  { id: 'eleven_monolingual_v1', name: 'Eleven Monolingual v1' },
  { id: 'eleven_multilingual_v1', name: 'Eleven Multilingual v1' },
]

// LMNT 语音合成接口提供的固定模型列表（LMNTSpeechModelId）
const LMNT_TTS_MODELS: ProviderModel[] = [
  { id: 'aurora', name: 'Aurora' },
  { id: 'blizzard', name: 'Blizzard' },
]

// Deepgram 语音合成接口提供的固定模型列表（DeepgramSpeechModelId，每个模型对应固定声线）
const DEEPGRAM_TTS_MODELS: ProviderModel[] = [
  { id: 'aura-asteria-en', name: 'Aura Asteria (en)' },
  { id: 'aura-2-asteria-en', name: 'Aura 2 Asteria (en)' },
  { id: 'aura-2-thalia-en', name: 'Aura 2 Thalia (en)' },
  { id: 'aura-2-helena-en', name: 'Aura 2 Helena (en)' },
  { id: 'aura-2-orpheus-en', name: 'Aura 2 Orpheus (en)' },
  { id: 'aura-2-zeus-en', name: 'Aura 2 Zeus (en)' },
  { id: 'aura-luna-en', name: 'Aura Luna (en)' },
  { id: 'aura-stella-en', name: 'Aura Stella (en)' },
]

// 千问语音合成（qwen3-tts-flash）的系统音色，见阿里云百炼文档「Qwen-TTS 音色列表」
const QWEN_TTS_VOICES: ProviderVoice[] = [
  ['Cherry', '芊悦', '阳光积极、亲切自然小姐姐'],
  ['Serena', '苏瑶', '温柔小姐姐'],
  ['Ethan', '晨煦', '阳光温暖的男声，略带北方口音'],
  ['Chelsie', '千雪', '二次元虚拟女友'],
  ['Momo', '茉兔', '撒娇搞怪'],
  ['Vivian', '十三', '拽拽的可爱小暴躁'],
  ['Moon', '月白', '率性帅气'],
  ['Maia', '四月', '知性与温柔的碰撞'],
  ['Kai', '凯', '耳朵的一场 SPA'],
  ['Nofish', '不吃鱼', '不会翘舌音的设计师'],
  ['Bella', '萌宝', '喝酒不打醉拳的小萝莉'],
  ['Jennifer', '詹妮弗', '品牌级电影质感美语女声'],
  ['Ryan', '甜茶', '节奏拉满、戏感炸裂'],
  ['Katerina', '卡捷琳娜', '御姐音色'],
  ['Aiden', '艾登', '精通厨艺的美语大男孩'],
  ['Eldric Sage', '沧明子', '沉稳睿智的老者'],
  ['Mia', '乖小妹', '温顺乖巧'],
  ['Mochi', '沙小弥', '聪明伶俐的小大人'],
  ['Bellona', '燕铮莺', '声音洪亮、吐字清晰'],
  ['Vincent', '田叔', '沙哑烟嗓'],
  ['Bunny', '萌小姬', '萌属性小萝莉'],
  ['Neil', '阿闻', '新闻主持人'],
  ['Elias', '墨讲师', '学科讲解风格'],
  ['Arthur', '徐大爷', '质朴嗓音讲奇闻异事'],
  ['Nini', '邻家妹妹', '软糯嗓音'],
  ['Seren', '小婉', '温和舒缓、助眠'],
  ['Pip', '顽屁小孩', '调皮童真'],
  ['Stella', '少女阿月', '甜美迷糊少女音'],
  ['Bodega', '博德加', '热情的西班牙大叔'],
  ['Sonrisa', '索尼莎', '热情开朗的拉美大姐'],
  ['Alek', '阿列克', '战斗民族的冷与暖'],
  ['Dolce', '多尔切', '慵懒的意大利大叔'],
  ['Sohee', '素熙', '温柔开朗的韩国欧尼'],
  ['Ono Anna', '小野杏', '鬼灵精怪的青梅竹马'],
  ['Lenn', '莱恩', '穿西装也听后朋克的德国青年'],
  ['Emilien', '埃米尔安', '浪漫的法国大哥哥'],
  ['Andre', '安德雷', '磁性沉稳男生'],
  ['Radio Gol', '拉迪奥·戈尔', '足球解说'],
  ['Jada', '上海-阿珍', '沪上阿姐（上海话）'],
  ['Dylan', '北京-晓东', '北京胡同少年（北京话）'],
  ['Li', '南京-老李', '耐心的瑜伽老师（南京话）'],
  ['Marcus', '陕西-秦川', '老陕味道（陕西话）'],
  ['Roy', '闽南-阿杰', '台湾哥仔形象（闽南语）'],
  ['Peter', '天津-李彼得', '天津相声捧哏（天津话）'],
  ['Sunny', '四川-晴儿', '甜的川妹子（四川话）'],
  ['Eric', '四川-程川', '成都男子（四川话）'],
  ['Rocky', '粤语-阿强', '幽默陪聊（粤语）'],
  ['Kiki', '粤语-阿清', '甜美港妹（粤语）'],
].map(([id, name, description]) => ({ id: id!, name: `${name}（${id}）`, description }))

// Deepgram 语音识别接口提供的模型（DeepgramTranscriptionModelId 中常用的几个）
const DEEPGRAM_ASR_MODELS: ProviderModel[] = [
  { id: 'nova-3', name: 'Nova 3', description: '最新，准确率最高' },
  { id: 'nova-2', name: 'Nova 2', description: '支持的语言最多（含中文）' },
  { id: 'nova-2-general', name: 'Nova 2 General' },
  { id: 'enhanced', name: 'Enhanced' },
  { id: 'base', name: 'Base' },
]

// ElevenLabs 语音识别接口提供的模型（ElevenLabsTranscriptionModelId）
const ELEVENLABS_ASR_MODELS: ProviderModel[] = [
  { id: 'scribe_v1', name: 'Scribe v1' },
  { id: 'scribe_v1_experimental', name: 'Scribe v1 Experimental' },
]

// OpenAI 兼容接口返回的模型中，用来识别语音的模型（如 whisper-1、gpt-4o-transcribe、SenseVoiceSmall）
const ASR_MODEL_PATTERN = /whisper|transcribe|asr|sensevoice|paraformer|speech-?to-?text|stt/i

/** 按 provider 的种类筛选 OpenAI 兼容接口返回的模型；语音识别一个都没筛到时（如本地服务）返回全部 */
export function filterModelsByCategory(ids: string[], category: ProviderCategory): string[] {
  if (category === 'tts') return ids.filter((id) => id.includes('tts'))
  if (category === 'asr') {
    const matched = ids.filter((id) => ASR_MODEL_PATTERN.test(id))
    return matched.length > 0 ? matched : ids
  }
  return ids.filter((id) => !id.includes('tts'))
}

// index-tts 本地服务的请求头，未配置 apiKey 时不携带鉴权信息
function indexTTSHeaders(provider: Provider): Record<string, string> {
  return provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}
}

// 各协议对应的 handlers 实现，供预置 provider 与 addProvider 自动填充使用
const PROTOCOL_HANDLERS: Record<ProviderProtocol, ProviderHandlers> = {
  openai: {
    validator: async function (this: Provider) {
      try {
        await get(`${this.baseUrl.replace(/\/$/, '')}/models`, {
          headers: { Authorization: `Bearer ${this.apiKey}` },
        })
        return true
      }
      catch (error) {
        console.error(error)
        return false
      }
    },
    listModels: async function (this: Provider) {
      try {
        const { data } = await get<{ data: { id: string }[] }>(`${this.baseUrl.replace(/\/$/, '')}/models`, {
          headers: { Authorization: `Bearer ${this.apiKey}` },
        })
        return filterModelsByCategory(data.map((model) => model.id), this.category).map((id): ProviderModel => ({ id, name: id }))
      }
      catch (error) {
        console.error(error)
        return []
      }
    },
    listVoices: async function (this: Provider) {
      if (this.id === 'openai_tts') return OPENAI_TTS_VOICES
      return []
    },
  },
  anthropic: {
    validator: async function (this: Provider) {
      try {
        await get(`${this.baseUrl.replace(/\/$/, '')}/models`, {
          headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
        })
        return true
      }
      catch (error) {
        console.error(error)
        return false
      }
    },
    listModels: async function (this: Provider) {
      try {
        const { data } = await get<{ data: { id: string, display_name?: string }[] }>(`${this.baseUrl.replace(/\/$/, '')}/models`, {
          headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
        })
        return data.map((model): ProviderModel => ({ id: model.id, name: model.display_name ?? model.id }))
      }
      catch (error) {
        console.error(error)
        return []
      }
    },
  },
  google: {
    validator: async function (this: Provider) {
      try {
        await get(`${this.baseUrl.replace(/\/$/, '')}/models`, {
          params: { key: this.apiKey },
        })
        return true
      }
      catch (error) {
        console.error(error)
        return false
      }
    },
    listModels: async function (this: Provider) {
      try {
        const { models } = await get<{ models: { name: string, displayName?: string }[] }>(`${this.baseUrl.replace(/\/$/, '')}/models`, {
          params: { key: this.apiKey },
        })
        return models.map((model): ProviderModel => ({ id: model.name.replace(/^models\//, ''), name: model.displayName ?? model.name }))
      }
      catch (error) {
        console.error(error)
        return []
      }
    },
  },
  elevenlabs: {
    validator: async function (this: Provider) {
      try {
        await get('https://api.elevenlabs.io/v1/user', {
          headers: { 'xi-api-key': this.apiKey },
        })
        return true
      }
      catch (error) {
        console.error(error)
        return false
      }
    },
    listModels: async function (this: Provider) {
      return this.category === 'asr' ? ELEVENLABS_ASR_MODELS : ELEVENLABS_TTS_MODELS
    },
    listVoices: async function (this: Provider) {
      try {
        const { voices } = await get<{ voices: { voice_id: string, name: string }[] }>('https://api.elevenlabs.io/v1/voices', {
          headers: { 'xi-api-key': this.apiKey },
        })
        return voices.map((voice): ProviderVoice => ({ id: voice.voice_id, name: voice.name }))
      }
      catch (error) {
        console.error(error)
        return []
      }
    },
  },
  lmnt: {
    validator: async function (this: Provider) {
      try {
        await get('https://api.lmnt.com/v1/account', {
          headers: { 'X-API-Key': this.apiKey },
        })
        return true
      }
      catch (error) {
        console.error(error)
        return false
      }
    },
    listModels: async function () {
      return LMNT_TTS_MODELS
    },
    listVoices: async function (this: Provider) {
      try {
        const voices = await get<{ id: string, name: string }[]>('https://api.lmnt.com/v1/ai/voice/list', {
          headers: { 'X-API-Key': this.apiKey },
        })
        return voices.map((voice): ProviderVoice => ({ id: voice.id, name: voice.name }))
      }
      catch (error) {
        console.error(error)
        return []
      }
    },
  },
  hume: {
    validator: async function (this: Provider) {
      try {
        await get('https://api.hume.ai/v0/tts/voices', {
          headers: { 'X-Hume-Api-Key': this.apiKey },
          params: { provider: 'HUME_AI', page_size: 1 },
        })
        return true
      }
      catch (error) {
        console.error(error)
        return false
      }
    },
    // Hume 的 speech() 接口不需要指定模型
    listModels: async function () {
      return []
    },
    listVoices: async function (this: Provider) {
      try {
        const { voices_page } = await get<{ voices_page: { id: string, name: string }[] }>('https://api.hume.ai/v0/tts/voices', {
          headers: { 'X-Hume-Api-Key': this.apiKey },
          params: { provider: 'HUME_AI', page_size: 100 },
        })
        return voices_page.map((voice): ProviderVoice => ({ id: voice.id, name: voice.name }))
      }
      catch (error) {
        console.error(error)
        return []
      }
    },
  },
  deepgram: {
    validator: async function (this: Provider) {
      try {
        await get('https://api.deepgram.com/v1/projects', {
          headers: { Authorization: `Token ${this.apiKey}` },
        })
        return true
      }
      catch (error) {
        console.error(error)
        return false
      }
    },
    // 语音合成的声线已编码在模型 id 中（如 aura-asteria-en），无需单独的声线列表
    listModels: async function (this: Provider) {
      return this.category === 'asr' ? DEEPGRAM_ASR_MODELS : DEEPGRAM_TTS_MODELS
    },
    listVoices: async function () {
      return []
    },
  },
  // 阿里云百炼（千问）：语音合成与语音识别使用原生接口（见 utils/dashscope.ts），模型列表来自 OpenAI 兼容接口
  dashscope: {
    validator: async function (this: Provider) {
      try {
        await get(`${dashscopeCompatibleUrl(this.baseUrl)}/models`, {
          headers: { Authorization: `Bearer ${this.apiKey}` },
        })
        return true
      }
      catch (error) {
        console.error(error)
        return false
      }
    },
    listModels: async function (this: Provider) {
      let ids: string[] = []
      try {
        const { data } = await get<{ data: { id: string }[] }>(`${dashscopeCompatibleUrl(this.baseUrl)}/models`, {
          headers: { Authorization: `Bearer ${this.apiKey}` },
        })
        ids = data.map((model) => model.id)
      }
      catch (error) {
        console.error(error)
      }
      return dashscopeModels(ids, this.category)
    },
    listVoices: async function () {
      return QWEN_TTS_VOICES
    },
  },
  // MiniMax：语音合成使用自家的 T2A v2 接口（见 utils/minimax.ts），声线从接口查询，模型列表是固定的
  minimax: {
    validator: async function (this: Provider) {
      try {
        await validateMiniMax(this)
        return true
      }
      catch (error) {
        console.error(error)
        return false
      }
    },
    listModels: async function () {
      return MINIMAX_TTS_MODELS
    },
    listVoices: async function (this: Provider) {
      try {
        return await listMiniMaxVoices(this)
      }
      catch (error) {
        console.error(error)
        return []
      }
    },
  },
  // Fish Audio：语音合成与语音识别使用自家的接口（见 utils/fish-audio.ts），声线从声线库查询，模型列表是固定的
  'fish-audio': {
    validator: async function (this: Provider) {
      try {
        await validateFishAudio(this)
        return true
      }
      catch (error) {
        console.error(error)
        return false
      }
    },
    listModels: async function (this: Provider) {
      return this.category === 'asr' ? FISH_AUDIO_ASR_MODELS : FISH_AUDIO_TTS_MODELS
    },
    listVoices: async function (this: Provider) {
      try {
        return await listFishAudioVoices(this)
      }
      catch (error) {
        console.error(error)
        return []
      }
    },
  },
  // 本地部署的 IndexTTS
  'index-tts': {
    validator: async function (this: Provider) {
      try {
        await get(`${this.baseUrl.replace(/\/$/, '')}/models`, {
          headers: indexTTSHeaders(this),
        })
        return true
      }
      catch (error) {
        console.error(error)
        return false
      }
    },
    listModels: async function (this: Provider) {
      try {
        const { data } = await get<{ data: { id: string }[] }>(`${this.baseUrl.replace(/\/$/, '')}/models`, {
          headers: indexTTSHeaders(this),
        })
        return data.map((model): ProviderModel => ({ id: model.id, name: model.id }))
      }
      catch (error) {
        console.error(error)
        return []
      }
    },
    listVoices: async function (this: Provider) {
      try {
        const { voices } = await get<{ voices: { id: string, name: string }[] }>(`${this.baseUrl.replace(/\/$/, '')}/audio/voices`, {
          headers: indexTTSHeaders(this),
        })
        return voices.map((voice): ProviderVoice => ({ id: voice.id, name: voice.name }))
      }
      catch (error) {
        console.error(error)
        return []
      }
    },
    // 上传新的音色参考音频，服务端会将其转换为 wav 并保存为同名预设。失败时抛出异常，由调用方提示用户
    uploadVoice: async function (this: Provider, file: Blob, name: string, options: { overwrite?: boolean } = {}) {
      const body = new FormData()
      body.append('name', name)
      body.append('file', file, file instanceof File ? file.name : `${name}.wav`)
      body.append('overwrite', String(options.overwrite ?? false))

      const voice = await post<{ id: string, name: string }>(`${this.baseUrl.replace(/\/$/, '')}/audio/voices`, {
        headers: indexTTSHeaders(this),
        body,
      })
      return { id: voice.id, name: voice.name }
    },
    deleteVoice: async function (this: Provider, voiceId: string) {
      await del(`${this.baseUrl.replace(/\/$/, '')}/audio/voices/${encodeURIComponent(voiceId)}`, {
        headers: indexTTSHeaders(this),
      })
    },
  },
}

const defaultProviders: Provider[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    category: 'llm',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    description: 'OpenAI 提供的 ChatGPT 系列大语言模型。',
    isValid: false,
    models: [],
    selectedModelId: '',
    ...PROTOCOL_HANDLERS.openai,
  },
  {
    id: 'anthropic',
    name: 'Claude',
    category: 'llm',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKey: '',
    description: 'Anthropic 提供的 Claude 系列大语言模型。',
    isValid: false,
    models: [],
    selectedModelId: '',
    ...PROTOCOL_HANDLERS.anthropic,
  },
  {
    id: 'google',
    name: 'Gemini',
    category: 'llm',
    protocol: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: '',
    description: 'Google 提供的 Gemini 系列大语言模型。',
    isValid: false,
    models: [],
    selectedModelId: '',
    ...PROTOCOL_HANDLERS.google,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    category: 'llm',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    description: 'DeepSeek 提供的 DeepSeek 系列大语言模型。',
    isValid: false,
    models: [],
    selectedModelId: '',
    ...PROTOCOL_HANDLERS.openai,
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    category: 'llm',
    protocol: 'openai',
    baseUrl: 'https://api.siliconflow.ai/v1',
    apiKey: '',
    description: 'SiliconFlow 提供的大语言模型。',
    isValid: false,
    models: [],
    selectedModelId: '',
    ...PROTOCOL_HANDLERS.openai,
  },
  {
    id: 'my-api',
    name: 'My API',
    category: 'llm',
    protocol: 'openai',
    baseUrl: 'https://easymagic.ai/v1',
    apiKey: '',
    description: '自定义 API。',
    isValid: false,
    models: [],
    selectedModelId: '',
    ...PROTOCOL_HANDLERS.openai,
  },
  
  {
    id: 'openai_tts',
    name: 'OpenAI TTS',
    category: 'tts',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    description: 'OpenAI 提供的语音合成服务。',
    isValid: false,
    models: [],
    selectedModelId: '',
    voices: [],
    selectedVoiceId: '',
    ...PROTOCOL_HANDLERS.openai,
  },
  {
    id: 'index-tts',
    name: 'IndexTTS',
    category: 'tts',
    protocol: 'index-tts',
    baseUrl: 'http://localhost:8000/v1',
    apiKey: '',
    description: '本地部署的 IndexTTS',
    isValid: false,
    models: [],
    selectedModelId: '',
    voices: [],
    selectedVoiceId: '',
    ...PROTOCOL_HANDLERS['index-tts'],
  },
  {
    id: 'openai_asr',
    name: 'OpenAI 语音识别',
    category: 'asr',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    description: 'OpenAI 提供的语音识别服务（Whisper、gpt-4o-transcribe）。',
    isValid: false,
    models: [],
    selectedModelId: '',
    ...PROTOCOL_HANDLERS.openai,
  },
  {
    id: 'siliconflow_asr',
    name: 'SiliconFlow 语音识别',
    category: 'asr',
    protocol: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: '',
    description: 'SiliconFlow 提供的语音识别服务（如 SenseVoiceSmall，中文效果好）。',
    isValid: false,
    models: [],
    selectedModelId: '',
    ...PROTOCOL_HANDLERS.openai,
  },
]

/** 读取保存的 provider 列表时，加上列表中还没有的预置 provider（如新增的语音识别）；预置的 provider 不能删除 */
function mergeDefaultProviders(stored: Provider[], defaults: Provider[]): Provider[] {
  const missing = defaults.filter((preset) => !stored.some((provider) => provider.id === preset.id))
  // 复制一份，之后的修改不会改到预置的数据
  return missing.length ? [...stored, ...missing.map((preset) => ({ ...preset, models: [...preset.models] }))] : stored
}

export const useProvidersStore = defineStore('providers', () => {
  const providers = useLocalStorage<Provider[]>('settings/providers', defaultProviders, {
    mergeDefaults: mergeDefaultProviders,
  })

  // 缓存的已加载的 provider 信息（models / isValid 等）
  const cachedProviders = useLocalStorage<ProviderInfoCache[]>('settings/providers/cached', [])

  // 当前选中的 LLM / TTS / 语音识别 provider id
  const currentLLMProviderId = useLocalStorage<string>('settings/providers/currentLLM', 'my-api')
  const currentTTSProviderId = useLocalStorage<string>('settings/providers/currentTTS', '')
  const currentASRProviderId = useLocalStorage<string>('settings/providers/currentASR', '')

  const currentProviderIds = { llm: currentLLMProviderId, tts: currentTTSProviderId, asr: currentASRProviderId }

  /** 是否是所属种类中正在使用的 provider */
  function isCurrentProvider(provider: Pick<Provider, 'id' | 'category'>): boolean {
    return currentProviderIds[provider.category].value === provider.id
  }

  /** 设为所属种类中正在使用的 provider */
  function setCurrentProvider(provider: Pick<Provider, 'id' | 'category'>) {
    currentProviderIds[provider.category].value = provider.id
  }

  function getProviderById(id: string) {
    return providers.value.find((p) => p.id === id)
  }

  // 新增 provider
  async function addProvider(provider: Omit<Provider, ProviderHandlerKey>) {
    if (provider.id === '') provider.id = createProviderId()
    const newProvider = { ...provider } as Provider
    setProviderHandlers(newProvider)
    providers.value.push(newProvider)
    await loadProviderInfo(provider.id)
    return provider.id
  }

  // 删除 provider，并清理对其的引用
  function removeProvider(id: string) {
    const index = providers.value.findIndex((p) => p.id === id)
    if (index === -1) return

    providers.value.splice(index, 1)

    for (const current of Object.values(currentProviderIds)) {
      if (current.value === id) current.value = ''
    }
  }

  // 更新 provider 的部分字段
  async function updateProvider(id: string, patch: Partial<Omit<Provider, 'id'>>) {
    const provider = getProviderById(id)
    if (!provider) return

    // 仅当影响请求结果的字段发生变化时才需要重新加载信息
    const protocolChanged = 'protocol' in patch && patch.protocol !== provider.protocol
    const credentialsChanged = (
      ('protocol' in patch && patch.protocol !== provider.protocol)
      || ('baseUrl' in patch && patch.baseUrl !== provider.baseUrl)
      || ('apiKey' in patch && patch.apiKey !== provider.apiKey)
    )

    Object.assign(provider, { ...patch })

    if (protocolChanged) {
      setProviderHandlers(provider)
    }
    if (credentialsChanged) {
      await loadProviderInfo(id)
    }
  }

  function getLLMProviders(): Provider[] {
    return providers.value.filter((p) => p.category === 'llm')
  }

  function getTTSProviders(): Provider[] {
    return providers.value.filter((p) => p.category === 'tts')
  }

  function getASRProviders(): Provider[] {
    return providers.value.filter((p) => p.category === 'asr')
  }

  function getCurrentLLMProvider(): Provider | null {
    return getProviderById(currentLLMProviderId.value) ?? null
  }

  function getCurrentTTSProvider(): Provider | null {
    return getProviderById(currentTTSProviderId.value) ?? null
  }

  function getCurrentASRProvider(): Provider | null {
    return getProviderById(currentASRProviderId.value) ?? null
  }

  // 加载模型信息。force 为 true 时跳过缓存，强制重新请求
  async function loadProviderInfo(id: string, options: { force?: boolean } = {}) {
    const provider = getProviderById(id)
    if (!provider) return

    // 协议需要 apiKey / baseUrl 但未配置时，无需请求，直接标记为不可用
    if ((protocolRequiresApiKey(provider.protocol) && !provider.apiKey) || (protocolRequiresBaseUrl(provider.protocol) && !provider.baseUrl)) {
      provider.isValid = false
      provider.models = []
      if (provider.category === 'tts') provider.voices = []

      console.log('loadProviderInfo: no baseUrl or apiKey')

      return
    }

    const key = getProviderCacheKey(provider)

    if (!options.force) {
      const availableCache = cachedProviders.value.find((p) => p.key === key && p.timestamp > Date.now() - PROVIDER_INFO_CACHE_TTL)
      if (availableCache) {
        provider.isValid = availableCache.isValid
        provider.models = availableCache.models
        applyModelDefaults(provider)

        if (provider.category === 'tts') {
          provider.voices = availableCache.voices ?? []
          applyVoiceDefaults(provider)
        }

        console.log('loadProviderInfo: cached', provider.isValid, provider.models, provider.selectedModelId)

        return
      }
    }

    provider.isValid = await provider.validator()
    provider.models = await provider.listModels()
    applyModelDefaults(provider)

    if (provider.category === 'tts') {
      provider.voices = await provider.listVoices!()
      applyVoiceDefaults(provider)
    }

    console.log('loadProviderInfo: new', provider.isValid, provider.models, provider.selectedModelId)

    // 移除该 provider 的旧缓存，并清理其他 provider 的过期缓存
    cachedProviders.value = cachedProviders.value.filter((p) => p.id !== id && p.timestamp > Date.now() - PROVIDER_INFO_CACHE_TTL)
    // 不缓存失败结果，避免本地服务暂未启动时被标记为不可用长达 24 小时
    if (!provider.isValid) return
    cachedProviders.value.unshift({
      id,
      key,
      timestamp: Date.now(),
      models: provider.models,
      voices: provider.voices,
      isValid: provider.isValid
    })
  }

  // 强制刷新 provider 信息（忽略缓存），供用户手动刷新使用
  async function refreshProviderInfo(id: string) {
    await loadProviderInfo(id, { force: true })
  }

  // 重新拉取声线列表，并同步到缓存中
  async function reloadVoices(provider: Provider) {
    provider.voices = await provider.listVoices!()
    applyVoiceDefaults(provider)

    const cache = cachedProviders.value.find((p) => p.id === provider.id)
    if (cache) cache.voices = provider.voices
  }

  // 为支持自定义音色的 TTS provider 上传新的音色参考音频，返回新建的声线
  async function uploadProviderVoice(id: string, file: Blob, name: string, options?: { overwrite?: boolean }) {
    const provider = getProviderById(id)
    if (!provider?.uploadVoice) throw new Error('该 Provider 不支持上传音色')

    const voice = await provider.uploadVoice(file, name, options)
    await reloadVoices(provider)
    return voice
  }

  // 删除支持自定义音色的 TTS provider 中的声线
  async function deleteProviderVoice(id: string, voiceId: string) {
    const provider = getProviderById(id)
    if (!provider?.deleteVoice) throw new Error('该 Provider 不支持删除音色')

    await provider.deleteVoice(voiceId)
    await reloadVoices(provider)
  }

  function isDefaultProvider(id: string) {
    return defaultProviders.some((p) => p.id === id)
  }

  function setProviderHandlers(provider: Provider) {
    const handlers = PROTOCOL_HANDLERS[provider.protocol]
    provider.validator = handlers.validator
    provider.listModels = handlers.listModels
    if (provider.category === 'tts') {
      provider.listVoices = handlers.listVoices
      // 不支持自定义音色的协议为 undefined，切换协议时会一并清除
      provider.uploadVoice = handlers.uploadVoice
      provider.deleteVoice = handlers.deleteVoice
    }
  }

  function resetAllToDefault() {
    providers.value = defaultProviders
    cachedProviders.value = []
    currentLLMProviderId.value = 'my-api'
    currentTTSProviderId.value = 'index-tts'
    currentASRProviderId.value = ''
  }

  onMounted(async () => {
    // resetAllToDefault()
    providers.value.forEach(async (provider) => {
      setProviderHandlers(provider)
      await loadProviderInfo(provider.id)
    })
  })

  return {
    providers,
    currentLLMProviderId,
    currentTTSProviderId,
    currentASRProviderId,

    isCurrentProvider,
    setCurrentProvider,
    resetAllToDefault,
    getProviderById,
    addProvider,
    removeProvider,
    updateProvider,
    refreshProviderInfo,
    uploadProviderVoice,
    deleteProviderVoice,
    getLLMProviders,
    getTTSProviders,
    getASRProviders,
    getCurrentLLMProvider,
    getCurrentTTSProvider,
    getCurrentASRProvider,
    isDefaultProvider,
  }
})
