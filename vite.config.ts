import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueJsx from '@vitejs/plugin-vue-jsx'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    vueJsx(),
    vueDevTools(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    },
  },
  build: {
    rolldownOptions: {
      checks: {
        // @vueuse/core 的发布代码里有几处位置不对的 #__PURE__ 注释，Rolldown 会忽略它们并报警告，
        // 这只影响摇树优化、不影响打包结果，关掉这项检查以免每次构建都刷屏
        invalidAnnotation: false,
      },
    },
  },
})
