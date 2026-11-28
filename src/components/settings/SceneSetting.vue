<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import ShortcutRecorder from '@/components/settings/ShortcutRecorder.vue'
import { isTauri } from '@/composables/desktop'
import { useLanguageStore } from '@/stores/language'
import { DEFAULT_TOGGLE_SHORTCUT, useSceneStore } from '@/stores/scene'
import { isPresetLanguage, LANGUAGE_OPTIONS, languageLabel } from '@/utils/language'

const sceneStore = useSceneStore()
const languageStore = useLanguageStore()

function resetToDefault() {
  sceneStore.resetToDefault()
  languageStore.resetToDefault()
}

// 渲染分辨率可选档位
const RESOLUTION_OPTIONS = [1, 1.5, 2, 2.5, 3, 3.5, 4]
// 常用帧率档位
const FPS_PRESETS = [30, 60, 120, 144, 180, 240]
// 桌宠说完后，字幕再保留多少秒
const SUBTITLE_HIDE_DELAYS = [3, 5, 10, 30]

// 录制显示 / 隐藏快捷键时的提示（如缺少修饰键）
const toggleShortcutHint = ref('')

const resolutionIndex = computed(() => RESOLUTION_OPTIONS.indexOf(sceneStore.resolution))
const indicatorStyle = computed(() => ({
  width: `calc((100% - 8px) / ${RESOLUTION_OPTIONS.length})`,
  transform: `translateX(${resolutionIndex.value * 100}%)`,
  opacity: resolutionIndex.value === -1 ? 0 : 1,
}))

const isCustomFps = computed(() => !FPS_PRESETS.includes(sceneStore.maxFPS))

// 根据分辨率与帧率粗略估算画面负载（0~1），仅作直观参考
const load = computed(() => {
  const resolutionFactor = (Math.min(sceneStore.resolution, 4) / 4) ** 2
  const fpsFactor = Math.min(sceneStore.maxFPS, 240) / 240
  return Math.min(1, resolutionFactor * 0.55 + fpsFactor * 0.45)
})

const loadLevel = computed(() => {
  if (load.value < 0.35) return { label: '轻松', tone: 'low', hint: '画面负载较低，适合长时间挂机' }
  if (load.value < 0.7) return { label: '适中', tone: 'mid', hint: '画质与性能较为均衡' }
  return { label: '较高', tone: 'high', hint: '画质优先，可能占用较多显卡资源' }
})

// 环形仪表盘
const RING_RADIUS = 34
const RING_LENGTH = 2 * Math.PI * RING_RADIUS
const ringOffset = computed(() => RING_LENGTH * (1 - load.value))

// 以 0~100 的百分比形式编辑 sceneStore 中的某个音量（存储值为 0~1），并支持静音 / 取消静音
function useVolumeControl(key: 'playbackVolume' | 'motionVolume') {
  const percent = computed({
    get: () => Math.round(sceneStore[key] * 100),
    set: (value: number) => {
      sceneStore[key] = Math.min(Math.max(value, 0), 100) / 100
    },
  })

  // 静音前的音量，用于取消静音时恢复
  const beforeMute = ref(100)

  function toggleMute() {
    if (percent.value > 0) {
      beforeMute.value = percent.value
      percent.value = 0
    } else {
      percent.value = beforeMute.value || 100
    }
  }

  // 喇叭图标的档位：0 静音，1 较小，2 较大
  const level = computed(() => {
    if (percent.value === 0) return 0
    if (percent.value < 50) return 1
    return 2
  })

  return reactive({ percent, level, toggleMute })
}

const speechVolume = useVolumeControl('playbackVolume')
const motionVolume = useVolumeControl('motionVolume')

// 回复语言：可以选预置的语言，也可以自己输入（如 Italiano、四川话）；为空表示不指定
function useLanguageChoice(key: 'displayLanguage' | 'speechLanguage') {
  const value = computed(() => languageStore[key].trim())
  const isCustom = computed(() => !!value.value && !isPresetLanguage(value.value))

  function select(language: string) {
    languageStore[key] = language
  }

  function setCustom(event: Event) {
    languageStore[key] = (event.target as HTMLInputElement).value.trim()
  }

  return reactive({ value, isCustom, select, setCustom })
}

const languageSettings = [
  {
    id: 'display',
    label: '显示的语言',
    desc: '对话框和字幕中桌宠回复用的语言；不指定时通常跟着你说的语言',
    autoLabel: '不指定',
    control: useLanguageChoice('displayLanguage'),
  },
  {
    id: 'speech',
    label: '念的语言',
    desc: '桌宠念出来的语言。和显示的不同时，每句话念之前会先翻译（屏幕上仍显示原文），会多一次模型请求、稍晚一点开口',
    autoLabel: '与显示相同',
    control: useLanguageChoice('speechLanguage'),
  },
]

const languageSummary = computed(() => {
  const display = languageStore.displayLanguage.trim()
  const speech = languageStore.speechLanguage.trim()
  if (!display && !speech) return ''
  const shown = display ? languageLabel(display) : '不指定'
  return `显示：${shown} · 念：${speech ? languageLabel(speech) : shown}`
})

const volumeSettings = [
  { id: 'speech', label: '语音音量', desc: '桌宠说话时的音量，点击喇叭可静音', control: speechVolume },
  { id: 'motion', label: '动作音量', desc: '播放动作时模型自带的台词和音效的音量，点击喇叭可静音', control: motionVolume },
]
</script>

<template>
  <div class="scene-setting">
    <!-- 概览：画面负载仪表盘 -->
    <section class="overview" :class="loadLevel.tone">
      <div class="overview-text">
        <span class="overview-label">预估画面负载</span>
        <span class="overview-level">{{ loadLevel.label }}</span>
        <span class="overview-hint">{{ loadLevel.hint }}</span>
        <div class="overview-stats">
          <span class="stat"><b>{{ sceneStore.resolution }}×</b>分辨率</span>
          <span class="stat"><b>{{ sceneStore.maxFPS }}</b>FPS 上限</span>
          <span class="stat"><b>{{ speechVolume.percent }}%</b>语音</span>
          <span class="stat"><b>{{ motionVolume.percent }}%</b>动作</span>
          <button class="reset-button" @click="resetToDefault()">恢复默认</button>
        </div>
      </div>
      <svg class="gauge" viewBox="0 0 80 80" aria-hidden="true">
        <circle class="gauge-track" cx="40" cy="40" :r="RING_RADIUS" />
        <circle
          class="gauge-value"
          cx="40"
          cy="40"
          :r="RING_RADIUS"
          :stroke-dasharray="RING_LENGTH"
          :stroke-dashoffset="ringOffset"
        />
        <text class="gauge-text" x="40" y="44" text-anchor="middle">
          {{ Math.round(load * 100) }}
        </text>
      </svg>
    </section>

    <!-- 画面 -->
    <section class="tile">
      <header class="tile-head">
        <span class="tile-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="4" width="18" height="12" rx="2" />
            <path d="M8 20h8M12 16v4" />
          </svg>
        </span>
        <span class="tile-title">画面</span>
      </header>

      <div class="setting">
        <div class="setting-label">
          <span>渲染分辨率</span>
          <span class="setting-desc">倍率越高越清晰，同时更耗显卡资源</span>
        </div>
        <div class="segmented" role="radiogroup">
          <span class="segmented-indicator" :style="indicatorStyle" />
          <button
            v-for="option in RESOLUTION_OPTIONS"
            :key="option"
            type="button"
            role="radio"
            class="segment"
            :class="{ active: sceneStore.resolution === option }"
            :aria-checked="sceneStore.resolution === option"
            @click="sceneStore.resolution = option"
          >
            {{ option }}×
          </button>
        </div>
      </div>

      <div class="setting">
        <div class="setting-label">
          <span>最大帧率</span>
          <span class="setting-desc">限制每秒绘制次数，降低可减少耗电</span>
        </div>
        <div class="fps-options">
          <button
            v-for="fps in FPS_PRESETS"
            :key="fps"
            type="button"
            class="fps-chip"
            :class="{ active: sceneStore.maxFPS === fps }"
            @click="sceneStore.maxFPS = fps"
          >
            {{ fps }}
          </button>
          <label class="fps-custom" :class="{ active: isCustomFps }">
            <span>自定义</span>
            <input v-model.number="sceneStore.maxFPS" type="number" min="1" max="240" step="1" />
          </label>
        </div>
      </div>
    </section>

    <!-- 界面 -->
    <section class="tile">
      <header class="tile-head">
        <span class="tile-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="M7 15h4M14 15h3M7 11h2M12 11h5" />
          </svg>
        </span>
        <span class="tile-title">界面</span>
      </header>

      <div class="setting">
        <label class="toggle-setting">
          <span class="setting-label">
            <span>显示字幕</span>
            <span class="setting-desc">桌宠说话时在屏幕底部显示说的内容，说完后按下面的时间自动隐藏；鼠标停在字幕上时不会隐藏</span>
          </span>
          <span class="switch">
            <input v-model="sceneStore.showSubtitle" type="checkbox" />
            <span class="switch-track" />
          </span>
        </label>
        <div v-if="sceneStore.showSubtitle" class="fps-options">
          <button
            v-for="seconds in SUBTITLE_HIDE_DELAYS"
            :key="seconds"
            type="button"
            class="fps-chip"
            :class="{ active: sceneStore.subtitleHideDelay === seconds }"
            @click="sceneStore.subtitleHideDelay = seconds"
          >
            {{ seconds }} 秒
          </button>
        </div>
      </div>

      <div class="setting">
        <div class="setting-label">
          <span>显示 / 隐藏快捷键</span>
          <span class="setting-desc">在任意应用中按下快捷键，隐藏或重新显示桌宠，与托盘菜单的「显示 / 隐藏」相同</span>
        </div>
        <ShortcutRecorder
          v-model="sceneStore.toggleShortcut"
          :default-value="DEFAULT_TOGGLE_SHORTCUT"
          :disabled="!isTauri"
          @hint="toggleShortcutHint = $event"
        />
        <span v-if="toggleShortcutHint" class="setting-desc warn">{{ toggleShortcutHint }}</span>
        <span v-else-if="!isTauri" class="setting-desc warn">需要在桌面应用中使用</span>
        <span v-else-if="sceneStore.toggleShortcutError" class="setting-desc warn">{{ sceneStore.toggleShortcutError }}</span>
        <span v-else class="setting-desc ok">快捷键已生效</span>
      </div>
    </section>

    <!-- 语言：桌宠回复的语言（你自己输入的内容不受影响） -->
    <section class="tile">
      <header class="tile-head">
        <span class="tile-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
          </svg>
        </span>
        <span class="tile-title">语言</span>
        <span v-if="languageSummary" class="tile-summary">{{ languageSummary }}</span>
      </header>

      <div v-for="item in languageSettings" :key="item.id" class="setting">
        <div class="setting-label">
          <span>{{ item.label }}</span>
          <span class="setting-desc">{{ item.desc }}</span>
        </div>
        <div class="fps-options">
          <button
            type="button"
            class="fps-chip"
            :class="{ active: !item.control.value }"
            @click="item.control.select('')"
          >
            {{ item.autoLabel }}
          </button>
          <button
            v-for="option in LANGUAGE_OPTIONS"
            :key="option.value"
            type="button"
            class="fps-chip"
            :class="{ active: item.control.value === option.value }"
            @click="item.control.select(option.value)"
          >
            {{ option.label }}
          </button>
          <label class="fps-custom language-custom" :class="{ active: item.control.isCustom }">
            <span>其他</span>
            <input
              type="text"
              placeholder="如 Italiano"
              :value="item.control.isCustom ? item.control.value : ''"
              @change="item.control.setCustom"
              @keydown.enter="($event.target as HTMLInputElement).blur()"
            />
          </label>
        </div>
      </div>
    </section>

    <!-- 声音 -->
    <section class="tile">
      <header class="tile-head">
        <span class="tile-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
          </svg>
        </span>
        <span class="tile-title">声音</span>
      </header>

      <div v-for="item in volumeSettings" :key="item.id" class="setting">
        <div class="setting-label">
          <span>{{ item.label }}</span>
          <span class="setting-desc">{{ item.desc }}</span>
        </div>
        <div class="volume">
          <button
            class="speaker"
            type="button"
            :class="{ muted: item.control.level === 0 }"
            :title="item.control.level === 0 ? '取消静音' : '静音'"
            @click="item.control.toggleMute()"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 9h4l5-4v14l-5-4H4z" />
              <template v-if="item.control.level === 0">
                <path d="M17 9l5 5M22 9l-5 5" />
              </template>
              <template v-else>
                <path d="M16.5 9.5a3.5 3.5 0 0 1 0 5" />
                <path v-if="item.control.level === 2" d="M19 7a7 7 0 0 1 0 10" />
              </template>
            </svg>
          </button>
          <input
            v-model.number="item.control.percent"
            class="volume-slider"
            type="range"
            min="0"
            max="100"
            step="1"
            :style="{ '--fill': `${item.control.percent}%` }"
          />
          <span class="volume-value">{{ item.control.percent }}<small>%</small></span>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped src="../../css/settings/SceneSetting.css"></style>
