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

export function isNativeShell(): boolean {
  return Capacitor.isNativePlatform();
}

export function kbVisible(): boolean {
  return visible;
}

/** 在应用启动时调一次，返回卸载函数 */
export function initKeyboard(): () => void {
  if (inited || !isNativeShell()) return () => {};
  inited = true;

  const subs = [
    Keyboard.addListener('keyboardWillShow', (info) => {
      visible = true;
      document.documentElement.style.setProperty('--kb', Math.round(info.keyboardHeight) + 'px');
      document.documentElement.dataset.kb = '1';
      window.dispatchEvent(new CustomEvent('kb:show'));
    }),
    Keyboard.addListener('keyboardWillHide', () => {
      visible = false;
      document.documentElement.style.setProperty('--kb', '0px');
      delete document.documentElement.dataset.kb;
      /* 给草稿框用：用户主动收起键盘 = 不要这条了（空的时候才撤，见 NewCell） */
      window.dispatchEvent(new CustomEvent('kb:hide'));
    }),
  ];

  return () => {
    subs.forEach((p) => { p.then((h) => h.remove()).catch(() => {}); });
    inited = false;
  };
}
