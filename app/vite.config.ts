import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// 版本号从 package.json 读，**不在源码里再抄一份** —— 抄一份的下场是
// 发版时改了 package.json 忘了改 src，设置页上「关于」那张卡永远停在上一个版本。
// 用 readFileSync 而不是 `import pkg from './package.json'`：vite.config.ts
// 不在 tsconfig 的 include 里，走 JSON import 要额外伺候 import assertions。
const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

export default defineConfig({
  // 相对路径：产物要跑在 https://…/schedule/ 这个子目录下，
  // 用绝对路径 /assets/… 会指到站点根上去，直接白屏
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
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
