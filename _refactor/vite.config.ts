import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 前端源码在 src/，构建产物在 dist/。
// nginx 只指向 dist/ —— 源码与 node_modules 不对外暴露。
// base 用绝对路径，因为应用挂在 /schedule/ 子路径下。
export default defineConfig({
  plugins: [react()],
  base: '/schedule/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 应用很小，不需要 sourcemap 上生产
    sourcemap: false,
    target: 'es2020',
  },
  server: {
    port: 5181,
  },
})
