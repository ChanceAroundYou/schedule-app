/**
 * widget.ts —— 把状态推给桌面小组件
 *
 * **数据通道**：App 每次数据变化 → 序列化成快照 JSON →
 * `@capacitor/preferences`（底层就是 MODE_PRIVATE SharedPreferences，
 * 原生侧能直接读）→ 发广播让小组件重画。
 *
 * 为什么绕这么一圈：小组件是独立进程，读不到 IndexedDB、跑不了 React，
 * 更不能走同步引擎。SharedPreferences 是唯一两边都能读写的地方。
 *
 * **只写不读**：小组件不需要反向读（它自己从那份 JSON 画）。
 * 打卡的勾选回写是另一条路，见 `pendingWidgetOps.ts`。
 */

import { Capacitor, registerPlugin } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { serializeWidgetSnapshot } from '../domain/widgetSnapshot.ts';
import { API_BASE } from './api/request.ts';
import type { LocalState } from '../domain/types.ts';

/** 原生侧读同一个 key。**两边必须一致**，改这里要同步改 Kotlin */
export const WIDGET_SNAPSHOT_KEY = 'schedule_widget_snapshot';

interface WidgetBridgePlugin {
  /** 通知指定小组件重画。provider 传组件类全名 */
  refresh(options: { provider: string }): Promise<{ ids: number }>;
  /**
   * 把登录票与接口基址交给原生侧存着。
   *
   * 这是 **B 方案**的关键一步：小组件要能不打开 App 就读写服务器，就得有票。
   * 而小组件不自己登录（那要在原生侧存口令，太危险），所以由 App 登录成功后
   * 把票推过来。登出时要调 clearAuth。
   */
  setAuth(options: { token: string; base: string }): Promise<{ ok: boolean }>;
  clearAuth(): Promise<{ ok: boolean }>;
  /**
   * 系统栏实际占用的尺寸（CSS px）。见 WidgetBridge.java 的 insets。
   *
   * 走原生是因为 Android 15+ 强制 edge-to-edge，而 Capacitor 的
   * `setOverlaysWebView` 在那儿已经不可用、WebView 里的
   * `env(safe-area-inset-top)` 又恒为 0。
   */
  insets(): Promise<{ top: number; bottom: number; left: number; right: number }>;
  /**
   * 立刻检查 App 新版本（关于页「检查更新」按钮）。
   *
   * 走原生是因为**更新提示本身在原生侧**（AppUpdate.java 弹的框），网页只能
   * 触发它，不能替它决定「有没有新版本」。force = true：跳过 24h 冷却，
   * 「已是最新」也有 toast 回执。
   */
  checkUpdate(): Promise<{ ok: boolean }>;
}

const WidgetBridge = registerPlugin<WidgetBridgePlugin>('WidgetBridge');

/**
 * 把当前状态写进 SharedPreferences 并通知小组件。
 *
 * **静默失败**：写快照失败不影响用户正在做的事（他只是桌面没更新而已），
 * 所以这里不抛。真正该被用户看到的是同步失败，那个走 `state.lastError`。
 */
export async function publishWidgetSnapshot(state: LocalState): Promise<void> {
  let json: string;
  try {
    json = serializeWidgetSnapshot(state);
  } catch (_) {
    return;
  }

  try {
    await Preferences.set({ key: WIDGET_SNAPSHOT_KEY, value: json });
  } catch (_) {
    return;
  }

  if (!Capacitor.isNativePlatform()) return;

  // 小程序件可能有多个，各自都刷一遍。类名写在这里而不是让原生写死 ——
  // 见 WidgetBridge.java 的注释
  const providers = [
    'space.xiaokubao.schedule.ScheduleWidgetProvider',
    'space.xiaokubao.schedule.HabitWidgetProvider',
  ];
  for (const p of providers) {
    try { await WidgetBridge.refresh({ provider: p }); } catch (_) { /* 这个没有实例 */ }
  }
}

/**
 * 把登录票推给原生侧，让小组件能直连服务器。
 *
 * 只在原生平台有意义（网页版没有小组件）。**静默失败** —— 推不成只是
 * 小组件退回「只显示快照 + 攒待同步队列」，不影响 App 本身。
 *
 * base 用打包时注入的那个（`VITE_API_BASE`），和请求用的是同一个值。
 */
export async function pushWidgetAuth(token: string): Promise<void> {
  if (!Capacitor.isNativePlatform() || !token) return;
  try {
    await WidgetBridge.setAuth({ token, base: API_BASE });
  } catch (_) {
    // 原生侧没这个插件（旧 APK）时也会走到这儿，忽略即可
  }
}

/** 登出 / 票失效时清掉原生侧那份 */
export async function clearWidgetAuth(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await WidgetBridge.clearAuth();
  } catch (_) { /* 同上 */ }
}


/* ---------------------------------------------------------------- 安全区 */

/**
 * 把系统栏的实际占位写进 CSS 变量，供布局做内边距。
 *
 * 变量名与 CSS 里的兜底值（`--sat` 等，见 styles/shell.css）是一对：
 * **不调这个函数时它们就是空的**，CSS 会退化成原来的样子 ——
 * 所以网页版（浏览器里跑）完全不受影响，只有 App 里才会多出这几像素。
 *
 * 只对 App 生效：Capacitor.isNativePlatform() 为假时直接返回，
 * 免得在浏览器控制台刷一堆「插件不存在」。
 */
export async function applySafeAreaInsets(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const r = await WidgetBridge.insets();
    const root = document.documentElement;
    const px = (v: number) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0) + 'px';
    root.style.setProperty('--sat', px(r.top));
    root.style.setProperty('--sab', px(r.bottom));
    root.style.setProperty('--sal', px(r.left));
    root.style.setProperty('--sar', px(r.right));
  } catch (_) {
    // 量不到就算了 —— CSS 的兜底值本来就是 0，界面退回加边距之前的样子
  }
}

/* ---------------------------------------------------------------- 检查更新 */

/**
 * 让原生侧立刻检查一次 App 更新（关于页「检查更新」按钮）。
 *
 * 只在 App 里有意义（网页版没有原生那一层），且**不抛**：旧版 APK 没有这个
 * 插件方法时调用会 reject，那时静默就好 —— 只是按钮点了没反应，比崩了强。
 * 有更新时会由原生弹框，走的是和启动时同一条下载 + 校验 + 安装链路。
 */
export async function checkAppUpdate(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try { await WidgetBridge.checkUpdate(); } catch (_) { /* 旧版没有这个方法 */ }
}

