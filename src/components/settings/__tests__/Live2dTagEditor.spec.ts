import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import Live2dTagEditor from '@/components/settings/Live2dTagEditor.vue'

const items = [
  { key: 'smile', label: 'smile', tags: ['happy', 'love'], custom: false },
  { key: 'cry', label: 'cry', tags: [], custom: true },
]

describe('情绪标签编辑', () => {
  it('每行显示标签的中文名、是否改过；点「编辑」后勾选或取消标签', async () => {
    const wrapper = mount(Live2dTagEditor, { props: { items } })
    const rows = wrapper.findAll('.tag-row')
    expect(rows[0]!.findAll('.row-tags .chip').map((chip) => chip.text())).toEqual(['开心', 'love'])
    expect(rows[0]!.find('.row-source').exists()).toBe(false)
    expect(rows[1]!.text()).toContain('未打标签')
    expect(rows[1]!.find('.row-source').exists()).toBe(true)

    await rows[0]!.get('.row-edit').trigger('click')
    const picker = wrapper.get('.picker')
    // 取消已有的标签、勾选新的标签
    await picker.findAll('.chip.selectable').find((chip) => chip.text() === '开心')!.trigger('click')
    await picker.findAll('.chip.selectable').find((chip) => chip.text() === '轻笑')!.trigger('click')
    // 模型文件中不认识的标签可以取消
    await picker.findAll('.chip.selectable').find((chip) => chip.text() === 'love')!.trigger('click')
    expect(wrapper.emitted('update')).toEqual([
      ['smile', ['love']],
      ['smile', ['happy', 'love', 'giggles']],
      ['smile', ['happy']],
    ])
  })

  it('改过的可以恢复为模型文件中的标签；可以预览时点 ▶ 播放', async () => {
    const wrapper = mount(Live2dTagEditor, { props: { items, playable: true } })
    const cry = wrapper.findAll('.tag-row')[1]!
    await cry.get('.row-edit').trigger('click')
    await wrapper.findAll('.picker-button').find((button) => button.text().includes('恢复'))!.trigger('click')
    expect(wrapper.emitted('update')).toEqual([['cry', null]])

    await cry.get('.row-play').trigger('click')
    expect(wrapper.emitted('play')).toEqual([['cry']])
  })
})
