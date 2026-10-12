/**
 * viewport.ts —— 视口 / 键盘 / 断网 hooks
 */

import { useState, useEffect } from 'react';

/**
 * 浏览器报告的联网状态。
 *
 * 断网时**界面必须说话**：改动确实什么都没丢（在 outbox 里排队），但用户看不到
 * 这句话，只会以为「点了没保存」，然后重复操作。
 *
 * 用 `navigator.onLine` 而不是「上一次请求成不成功」：前者能立刻反映网线拔掉，
 * 后者的代价是每加一个探针就多一次请求。
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(
    () => typeof navigator === 'undefined' || navigator.onLine,
  );
  useEffect(() => {
    const on = () => setOnline(navigator.onLine);
    window.addEventListener('online', on);
    window.addEventListener('offline', on);
    on();   // 事件监听之前状态可能就已经变了（比如从 bfcache 回来）
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', on);
    };
  }, []);
  return online;
}

/**
 * 手机软键盘遮住了多少 —— 写进 `--kb`，给**定位固定**的那几个面用。
 *
 * 为什么要 JS：软键盘只压小**可视视口**（visualViewport），布局视口不动 ——
 * 所以 `100dvh` 还是满屏高，`position: fixed; bottom: 0` 的那几个面板
 * （详情抽屉、Sheet、登录页）下半截正好压在键盘底下，而且固定定位的元素
 * 浏览器没法替我们滚上来。页内正常滚动的输入框不用管，浏览器自己会滚。
 *
 * 两个数字都要减：`offsetTop` 是可视视口自己的偏移，iOS 上键盘弹出时它会跑，
 * 不减的话算出来的高度偏大、面板会被顶过头。
 *
 * 有的浏览器（viewport 里写了 `interactive-widget=resizes-content`）会连布局
 * 视口一起缩，那时 `innerHeight` 也跟着小，这里自然算出 0 —— 而那种模式下
 * `bottom: 0` 本来就贴着键盘上沿了，不用再动。两种情况都对。
 */
export function useKeyboardInset(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;   // 老浏览器：退回「浏览器自己滚」，不报错也不做事
    const apply = () => {
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty('--kb', Math.round(kb) + 'px');
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      document.documentElement.style.removeProperty('--kb');
    };
  }, []);
}

/** 窗口宽度是否落在窄屏（与 styles.css 的 @media 断点必须一致） */
const NARROW = '(max-width: 900px)';

export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(NARROW).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}
