import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ShortcutRecorder from '@/components/settings/ShortcutRecorder.vue'

function setup(modelValue = 'Ctrl+Alt+KeyS') {
  const wrapper = mount(ShortcutRecorder, {
    props: {
      'modelValue': modelValue,
      'defaultValue': 'Ctrl+Alt+KeyS',
      'onUpdate:modelValue': (value: string) => wrapper.setProps({ modelValue: value }),
    },
  })
  const recorder = wrapper.get('.shortcut-recorder')
  return { wrapper, recorder }
}

describe('快捷键录制', () => {
  it('显示为易读的形式，与默认值相同时没有「恢复默认」', () => {
    const { wrapper, recorder } = setup()
    expect(recorder.text()).toBe('Ctrl + Alt + S')
    expect(wrapper.find('.reset-button').exists()).toBe(false)
  })

  it('点击后按下组合键即可设置；只按修饰键时继续等待', async () => {
    const { wrapper, recorder } = setup()
    await recorder.trigger('click')
    expect(recorder.text()).toBe('请按下组合键…')

    await recorder.trigger('keydown', { key: 'Control', code: 'ControlLeft', ctrlKey: true })
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()

    await recorder.trigger('keydown', { key: 'h', code: 'KeyH', ctrlKey: true, shiftKey: true })
    expect(wrapper.emitted('update:modelValue')).toEqual([['Ctrl+Shift+KeyH']])
    expect(recorder.text()).toBe('Ctrl + Shift + H')
    expect(wrapper.find('.reset-button').exists()).toBe(true)
  })

  it('没有修饰键时提示，不修改；Esc 取消录制', async () => {
    const { wrapper, recorder } = setup()
    await recorder.trigger('click')
    await recorder.trigger('keydown', { key: 'h', code: 'KeyH' })
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(wrapper.emitted('hint')?.at(-1)).toEqual(['需要至少一个修饰键（Ctrl / Alt / Shift）'])

    await recorder.trigger('keydown', { key: 'Escape', code: 'Escape' })
    expect(wrapper.emitted('hint')?.at(-1)).toEqual([''])
    expect(recorder.text()).toBe('Ctrl + Alt + S')
  })

  it('没有在录制时按键不会修改；「恢复默认」改回默认值', async () => {
    const { wrapper, recorder } = setup('Ctrl+Alt+KeyH')
    await recorder.trigger('keydown', { key: 'q', code: 'KeyQ', ctrlKey: true })
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()

    await wrapper.get('.reset-button').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([['Ctrl+Alt+KeyS']])
    expect(wrapper.find('.reset-button').exists()).toBe(false)
  })
})
