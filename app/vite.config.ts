import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // 相对路径：产物要跑在 https://…/schedule/ 这个子目录下，
  // 用绝对路径 /assets/… 会指到站点根上去，直接白屏
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // 源码映射只给开发用；线上多几 MB 的 .map 没人看
    sourcemap: false,
  },
  server: {
    port: 5199,
    // 开发时把 /api 打给本机后端，这样浏览器眼里前后端同源，
    // 后端一行 CORS 都不用写
    proxy: {
      '/api': { target: 'http://127.0.0.1:25692', changeOrigin: false },
    },
  },
  // `vite preview` 跑的是构建产物，用的是**另一份**配置 —— 不写这条的话
  // 预览里所有 API 请求都会 404，前端看起来「登录不上」，其实是没代理
  preview: {
    port: 5199,
    proxy: {
      '/api': { target: 'http://127.0.0.1:25692', changeOrigin: false },
    },
  },
});
