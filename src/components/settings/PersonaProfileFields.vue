<script lang="ts">
// 人设详情页与添加页共用的可编辑字段
export interface PersonaForm {
  name: string
  personality: string
  background: string
  speakingStyle: string
}
</script>

<script setup lang="ts">
import { computed } from 'vue'
import { getInitial, hashHue } from '@/utils/avatar'

const form = defineModel<PersonaForm>({ required: true })

type TextKey = Exclude<keyof PersonaForm, 'name'>

interface ProfileSection {
  key: TextKey
  title: string
  placeholder: string
  rows: number
  optional: boolean
  icon: string[]
  // 点击即可追加 / 移除的快捷词条
  suggestions: string[]
}

const sections: ProfileSection[] = [
  {
    key: 'personality',
    title: '性格特点',
    placeholder: '描述性格，如：活泼、温柔、有点小调皮…',
    rows: 3,
    optional: false,
    icon: ['M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z'],
    suggestions: ['活泼', '温柔', '傲娇', '元气', '冷静', '毒舌', '天然呆', '慵懒', '认真', '黏人'],
  },
  {
    key: 'background',
    title: '背景故事',
    placeholder: '描述角色的来历、经历、与用户的关系等',
    rows: 4,
    optional: true,
    icon: ['M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2z', 'M4 19a2 2 0 0 1 2-2h12', 'M9 7h5'],
    suggestions: [],
  },
  {
    key: 'speakingStyle',
    title: '说话风格',
    placeholder: '描述说话方式，如：语气轻快、喜欢在句尾加语气词…',
    rows: 3,
    optional: true,
    icon: ['M21 12a8 8 0 0 1-11.5 7.2L4 21l1.8-5.5A8 8 0 1 1 21 12z', 'M8.5 12h.01M12 12h.01M15.5 12h.01'],
    suggestions: ['口语化', '简短', '爱用语气词', '偶尔撒娇', '会吐槽', '礼貌'],
  },
]

// 词条之间使用顿号分隔
const SEPARATOR = '、'

function hasWord(key: TextKey, word: string) {
  return form.value[key].includes(word)
}

function toggleWord(key: TextKey, word: string) {
  const text = form.value[key]
  if (text.includes(word)) {
    form.value[key] = text
      .replace(new RegExp(`${SEPARATOR}?${word}`), '')
      .replace(new RegExp(`^${SEPARATOR}`), '')
    return
  }
  const trimmed = text.trimEnd()
  const needsSeparator = trimmed !== '' && !/[、，,。.！!？?；;\s]$/.test(trimmed)
  form.value[key] = `${trimmed}${needsSeparator ? SEPARATOR : ''}${word}`
}

const hue = computed(() => hashHue(form.value.name || 'persona'))
const avatarStyle = computed(() => ({
  background: `linear-gradient(135deg, hsl(${hue.value} 80% 68%), hsl(${(hue.value + 35) % 360} 85% 58%))`,
}))
</script>

<template>
  <div class="profile-hero">
    <div class="hero-banner">
      <span class="banner-glow" />
      <slot name="badge" />
    </div>
    <div class="hero-avatar" :style="avatarStyle">
      {{ form.name ? getInitial(form.name) : '?' }}
    </div>
    <input v-model="form.name" class="hero-name" type="text" placeholder="给角色起个名字" />
    <slot name="subtitle" />
  </div>

  <div class="profile-sections">
    <section v-for="section in sections" :key="section.key" class="note">
      <header class="note-head">
        <span class="note-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path v-for="d in section.icon" :key="d" :d="d" />
          </svg>
        </span>
        <span class="note-title">{{ section.title }}</span>
        <span v-if="section.optional" class="note-optional">可选</span>
        <span class="note-count">{{ form[section.key].length }} 字</span>
      </header>

      <textarea
        v-model="form[section.key]"
        class="note-text"
        :rows="section.rows"
        :placeholder="section.placeholder"
      />

      <div v-if="section.suggestions.length > 0" class="note-suggestions">
        <button
          v-for="word in section.suggestions"
          :key="word"
          type="button"
          class="suggestion"
          :class="{ used: hasWord(section.key, word) }"
          @click="toggleWord(section.key, word)"
        >
          {{ hasWord(section.key, word) ? '✓' : '+' }} {{ word }}
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped src="../../css/settings/PersonaSetting.css"></style>
