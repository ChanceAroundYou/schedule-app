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
    /* 让 fetch / XHR 走**原生网络栈**，而不是 WebView 的。原因（2026-10-17
       真机实测）：这台手机上 WebView 的 DNS 解析整体失效 —— 连 baidu.com 都
       报 net::ERR_NAME_NOT_RESOLVED，而系统 ping 和原生 HttpURLConnection
       都正常（「检查更新」能拉到版本清单）。表现就是 App 里一直挂着
       「连不上服务器」红条、同步全断。
       启用后 @capacitor/core 会 patch window.fetch / XMLHttpRequest，请求改由
       Android 原生发出，绕开 WebView 的网络栈。网页版不受影响（这段只在
       Capacitor 原生壳里生效）。 */
    CapacitorHttp: {
      enabled: true,
    },
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
