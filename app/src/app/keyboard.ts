/**
 * keyboard.ts —— 键盘快捷键
 */

import { useEffect } from 'react';
import * as D from '../domain/date.ts';
import * as store from '../data/store.ts';

/**
 * 键盘快捷键。
 *
 * 时间轴上下沿的把手：方向键微调一档 15 分钟。
 * 只认「焦点在把手上」这一种情况 —— 把手是页面上仅有的两个不可点、
 * 只能拖的控件（其余 data-act 全是真 button，Tab 就能到）。
 */
function useKeyboard(deps: {
  shift: (n: number) => void;
  nav: (k: string) => void;
  openId: string | null;
  setOpenId: (id: string | null) => void;
  moreOpen: boolean;
  setMoreOpen: (v: boolean) => void;
  jumpOpen: boolean;
  setJumpOpen: (v: boolean) => void;
  searchOpen: boolean;
  setSearchOpen: (v: boolean) => void;
}) {
  const { shift, nav, openId, setOpenId, moreOpen, setMoreOpen, jumpOpen, setJumpOpen, searchOpen, setSearchOpen } = deps;

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (e.key === 'Escape') {
        // 逐层关闭，一次只关一层：更多抽屉 → 搜索浮条 → 找日期面板 → 抽屉。
        // 一次全关会让用户不知道自己刚关掉了什么
        if (moreOpen) setMoreOpen(false);
        else if (searchOpen) setSearchOpen(false);
        else if (jumpOpen) setJumpOpen(false);
        else if (openId) setOpenId(null);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      // 时间轴上下沿的把手：方向键微调一档 15 分钟。
      // dir 跟着时间轴方向：往下 = +1，往上 = -1（上沿往上拖是变长，别写反）。
      const handle = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-act="resize"],[data-act="resize-top"]');
      if (handle && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        const t = store.get().tasks[handle.dataset.id || ''];
        if (t) {
          store.patchTask(t.id, D.nudgeEdge(
            t.time, t.duration, handle.dataset.act === 'resize-top' ? 'top' : 'bottom',
            e.key === 'ArrowDown' ? 1 : -1,
          ));
        }
        return;
      }
      // 方向键只在 calendars / today 有意义（这两页才有「翻到哪天」这回事），
      // 而且**不换页** —— shift() 也跟着改了，不再往回塞 nav: 'calendar'
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const navNow = store.get().ui.nav;
        if (navNow !== 'calendar' && navNow !== 'today') return;
        e.preventDefault();
        shift(e.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
      if (e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        nav('calendar');
        setJumpOpen(true);   // 快捷方式的作用就该是「直接打开」，不是「切过去让你再点一下」
        return;
      }
      if (e.key === 't' || e.key === 'T') { e.preventDefault(); nav('today'); return; }
      // 1/2/3 切日 / 周 / 月 —— **要连带切到日程页**，否则在今天 / 待办箱这些
      // 页面上按了毫无反应（视图切了，但那些页面根本不渲染视图切换按钮）
      if (e.key === '1' || e.key === '2' || e.key === '3') {
        e.preventDefault();
        store.setUi({ nav: 'calendar', view: (['day', 'week', 'month'] as const)[+e.key - 1] });
      }
    };
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, [shift, nav, openId, setOpenId, moreOpen, setMoreOpen, jumpOpen, setJumpOpen, searchOpen, setSearchOpen]);
}

export { useKeyboard };
