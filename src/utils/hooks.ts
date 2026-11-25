import type { Ref } from 'vue'

/**
 * 向钩子列表中添加一个钩子，返回将其移除的函数。
 * 组件在 setup 中向全局 store 注册钩子时，应在卸载时调用返回的函数：
 * store 是单例，组件重新挂载（如开发时的热更新）后，旧组件留下的钩子仍会被调用
 */
export function addHook<T>(hooks: Ref<T[]>, hook: T): () => void {
  hooks.value.push(hook)
  return () => {
    const index = hooks.value.indexOf(hook)
    if (index !== -1) hooks.value.splice(index, 1)
  }
}
