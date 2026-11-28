import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { initDesktopWindow } from './composables/desktop'
import './css/base.css'

const app = createApp(App)

app.use(createPinia())
app.use(router)

app.mount('#app')

// 拖进来的文件没有被对话框接收时（如松开在面板以外，或是不支持的文件类型），
// 阻止浏览器直接打开它：否则文件会替换掉整个页面
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (event) => {
    if ([...(event.dataTransfer?.types ?? [])].includes('Files')) event.preventDefault()
  })
}

initDesktopWindow()
