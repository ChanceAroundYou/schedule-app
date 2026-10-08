/**
 * theme.ts —— 外观三轴（深浅 × 色板 × 风格）的控制器。
 *
 * 三轴**各自独立**，都是往 `documentElement` 上写一个 `data-*`，
 * 真正的取值全在 `styles/tokens.css` 的令牌块里。这里一个字都不重复 ——
 * 几何 / 颜色在 TS 里再抄一份，改 CSS 时必然漏一边（账本项目踩过）。
 *
 * 三个 apply* 是**幂等**的：写同样的值不会有副作用，所以调用方不用先比较。
 *
 * 默认档（light + jade + soft）与 2026-10-06 之前逐像素相同 —— 见 tokens.css
 * 里 `[data-style="soft"]` 那个空块。
 */
import type { AccentKey, StyleKey, ThemeMode } from '../domain/types.ts';

/**
 * 深浅三档。**这里只放标签** —— 实际生效值由 `resolveTheme()` 解析，
 * 不再存第二份状态，否则「跟随系统」时两份值会各说各话。
 */
export const THEMES: Record<ThemeMode, { label: string }> = {
  auto: { label: '跟随系统' },
  light: { label: '常亮' },
  dark: { label: '常暗' },
};

/**
 * 6 套色板。**只有标签，没有色值** —— 设置页那个色块把 `data-accent` 加在
 * 自己身上，再 `background: var(--primary)`。这样色块的颜色天然跟着深浅档走
 * （暗档的主色是提亮过的另一套值），不需要在这里维护第二份十六进制。
 */
export const ACCENTS: Record<AccentKey, { label: string }> = {
  jade: { label: '青玉' },
  azure: { label: '靛蓝' },
  clay: { label: '陶土' },
  plum: { label: '紫梅' },
  gold: { label: '麦金' },
  slate: { label: '石墨' },
};

export const STYLES: Record<StyleKey, { label: string }> = {
  soft: { label: '柔和' },
  flat: { label: '扁平' },
  notion: { label: 'Notion' },
};

/* ------------------------------------------------------------ 三轴的写入 */

/** 系统现在是哪一档。老 Safari 没有 matchMedia 的兜底在调用点（见 systemTheme） */
export function systemTheme(): 'light' | 'dark' {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** 把偏好解析成实际生效的那一档。`auto` 之外都是恒等 */
export function resolveTheme(m: ThemeMode): 'light' | 'dark' {
  return m === 'auto' ? systemTheme() : m;
}

/** 写 dataset.theme 与 color-scheme，返回**实际生效**的那一档（给图标用） */
export function applyTheme(m: ThemeMode): 'light' | 'dark' {
  const real = resolveTheme(m);
  const d = document.documentElement;
  d.dataset.theme = real;
  // color-scheme 让滚动条 / 表单控件 / 光标跟着走 —— 光有 data-theme 管不到它们
  d.style.colorScheme = real;
  return real;
}

export function applyAccent(k: AccentKey): void {
  document.documentElement.dataset.accent = k;
}

export function applyStyle(k: StyleKey): void {
  document.documentElement.dataset.style = k;
}

/**
 * 三轴一起写。**只留这一个入口**：分成三个函数让人在调用点少写一行，
 * 而少写的那一行不会有任何报错，只是「这个轴没生效」——
 * 三轴里坏一个，肉眼要翻 6×3×2 种组合才找得到。
 */
export function applyAppearance(pref: {
  theme: ThemeMode; accent: AccentKey; style: StyleKey;
}): 'light' | 'dark' {
  applyAccent(pref.accent);
  applyStyle(pref.style);
  return applyTheme(pref.theme);
}

/**
 * 订阅系统深浅变化。**只负责通知，不判断该不该生效** —— 判断在调用点
 * （`theme !== 'auto'` 时根本不该订阅）。返回退订函数。
 */
export function watchSystemTheme(cb: () => void): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}
