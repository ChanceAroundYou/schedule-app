import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor 配置 —— 把网页版打包成安卓 App
 *
 * **不开 `server.url`**：那样等于在 App 里打开网页，断网就白屏。这里把
 * `dist/` 打进 APK，界面资源是本地的，只有数据走网络 —— 跟网页版「离线
 * 能开、联网补交」的行为一致。
 *
 * **接口基址不在这儿配**，在构建时注入 `VITE_API_BASE`（见
 * `src/data/api/request.ts`）。原因是同一个 `dist/` 也可能用于网页版，
 * 写死在配置里会让两种产物互相干扰。
 *
 * WebView 源默认是 `https://localhost`（`androidScheme` + `hostname` 的
 * 默认值），后端 CORS 白名单里已经放了它 —— 改这两个值的話要同步改
 * `server/http.js` 的 `DEFAULT_CORS`。
 */
const config: CapacitorConfig = {
  appId: 'space.xiaokubao.schedule',
  appName: '日程清单',
  // vite 的 build.outDir 是项目根的 dist/，相对本文件要往上走一层
  webDir: '../dist',

  plugins: {
    // 软键盘弹起时把界面顶上去，别盖住输入框（网页版那条避让逻辑在这同样要）
    Keyboard: {
      resizeOnFullScreen: true,
    },
    // Android 15/16 对 target SDK 35+ 强制边到边，状态栏会压到内容上
    StatusBar: {
      overlaysWebView: false,
    },
  },
};

export default config;
