/**
 * kb.ts —— 软键盘的**原生事件**（只有 Capacitor 壳里才有）
 *
 * ## 为什么不能用 visualViewport 算
 *
 * 老写法：`键盘高度 = window.innerHeight - visualViewport.height - offsetTop`。
 * 在**桌面浏览器**上成立（键盘只压可视视口，布局视口不动）。
 *
 * 但 App 里是「键盘把整个界面压小」的模式（adjustResize）：`innerHeight` 跟着
 * 一起变小，相减恒等于 0 —— 于是「键盘弹起 / 收起」**从来没有被识别过**。
 * 用户实测的表现就是：手动收起键盘，草稿框留在屏幕上不消失（2026-10-17）。
 *
 * 所以原生壳里改用 `@capacitor/keyboard` 的事件（系统直接告知，可靠），
 * 顺手用它的 `keyboardHeight` 写 `--kb` —— 登录页 / 详情抽屉的避让也一起修好。
 *
 * 网页版没有原生壳，`initKeyboard()` 直接不做事，调用方退回 visualViewport 那一路。
 */

import { Capacitor } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';

/** 原生壳里键盘是否可见。非原生平台恒为 false */
let visible = false;
let inited = false;
/* 键盘收起时的窗口高度 = 「一整屏」的基准。下面 applyFix 拿它算压小量。 */
let baseH = 0;
/* 补高度的定时器（键盘动画分几拍，量晚了量早了都不准，干脆每拍都补一次） */
const fixTimers: number[] = [];

export function isNativeShell(): boolean {
  return Capacitor.isNativePlatform();
}

export function kbVisible(): boolean {
  return visible;
}

/**
 * 键盘把**窗口**压小了多少（CSS px）。0 = 窗口没动（老系统 / 网页版）。
 *
 * 为什么要自己量：清单里写了 `windowSoftInputMode="adjustNothing"`，
 * Capacitor 的 resizeOnFullScreen 也关掉了，但 **Android 15/16（targetSdk 35+，
 * 边到边）会强制 resize 窗口** —— 2026-10-22 真机实测：键盘 282px 起，
 * `window.innerHeight` 792 → 510，时间轴 464 → 182（用户报的「被压扁」）。
 * 系统这一层拦不住，只能在样式上把它补回来（`--kb-fix` + `.app` 的高度）。
 */
function shrink(): number {
  if (!visible || !baseH) return 0;
  const d = baseH - window.innerHeight;
  return d > 60 ? d : 0;          // 小抖动（地址栏之类）不算
}

function applyFix(): void {
  const d = shrink();
  document.documentElement.style.setProperty('--kb-fix', d + 'px');
}

/**
 * **真正看得见**的那块区域的底边（相对窗口顶部，CSS px）。
 * 草稿框被键盘挡住时靠它决定要往上挪多少（见 views/calendar/NewCell.tsx）。
 *
 * 两种机型都要对：窗口被压小的（补了 --kb-fix，看到的还是满屏，
 * 底边 = innerHeight）与窗口没动的（底边 = innerHeight - 键盘高）。
 */
export function visibleBottom(): number {
  const kb = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--kb'),
  ) || 0;
  return window.innerHeight - (shrink() ? 0 : kb);
}

/** 在应用启动时调一次，返回卸载函数 */
export function initKeyboard(): () => void {
  if (inited || !isNativeShell()) return () => {};
  inited = true;
  baseH = window.innerHeight;

  const subs = [
    Keyboard.addListener('keyboardWillShow', (info) => {
      visible = true;
      /* 记下「弹起前」的高度：这一次的 innerHeight 可能已经被压小了 */
      if (!baseH) baseH = window.innerHeight;
      document.documentElement.style.setProperty('--kb', Math.round(info.keyboardHeight) + 'px');
      document.documentElement.dataset.kb = '1';
      /* 系统 resize 是跟键盘动画一起做的，任一拍量都可能对不上 —— 三拍都补 */
      for (const d of [0, 140, 380, 700]) {
        fixTimers.push(window.setTimeout(applyFix, d));
      }
      window.dispatchEvent(new CustomEvent('kb:show'));
    }),
    Keyboard.addListener('keyboardWillHide', () => {
      visible = false;
      while (fixTimers.length) window.clearTimeout(fixTimers.pop());
      document.documentElement.style.setProperty('--kb', '0px');
      document.documentElement.style.setProperty('--kb-fix', '0px');
      delete document.documentElement.dataset.kb;
      /* 收起动画结束后再取新基准（旋转屏幕也会走这儿） */
      fixTimers.push(window.setTimeout(() => { baseH = window.innerHeight; }, 400));
      /* 给草稿框用：用户主动收起键盘 = 不要这条了（空的时候才撤，见 NewCell） */
      window.dispatchEvent(new CustomEvent('kb:hide'));
    }),
  ];

  /* 转屏 / 切换分屏：键盘没弹的时候窗口高度就是新基准 */
  const onResize = () => { if (!visible) baseH = window.innerHeight; };
  window.addEventListener('resize', onResize);

  return () => {
    subs.forEach((p) => { p.then((h) => h.remove()).catch(() => {}); });
    window.removeEventListener('resize', onResize);
    while (fixTimers.length) window.clearTimeout(fixTimers.pop());
    inited = false;
  };
}
