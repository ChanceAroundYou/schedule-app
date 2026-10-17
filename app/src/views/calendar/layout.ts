/**
 * layout.ts —— 视图尺寸 / 滚动位置
 */

import { useEffect, useLayoutEffect, useRef } from 'react';
import * as D from '../../domain/date.ts';
import { DAY_H } from '../../domain/layout.ts';

const MONTH_ROW_MIN = 104;
const MONTH_ROW_MAX = 132;
const MONTH_HEAD_H = 30;

/** 量出内容区减去内边距的净高。不写 calc(100vh - N)：工具栏 / 缩放 / 系统字号都会让 N 猜错 */
function availHeight(el: HTMLElement): number {
  const cs = getComputedStyle(el);
  return el.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
}

/**
 * 窄屏下周视图 7 列要横滑，把「今天 / 选中的那天」摆到可视区中间 ——
 * 一屏只看得见 3 天，不定位的话用户根本不知道左右还有。
 *
 * 周一和周日**居中不了**（一边没有列），算出来的 scrollLeft 会越界，
 * clamp 之后自然贴边，所以不需要特判。
 */
function centerWeekDay(g: HTMLElement, iso: string) {
  const cols = g.querySelector<HTMLElement>('.week-cols');
  if (!cols || !cols.children.length) return;
  const first = cols.children[0] as HTMLElement;
  const colW = first.getBoundingClientRect().width;
  if (!colW) return;
  // 第一列左缘到滚动内容左缘的距离 = 左侧刻度列宽。刻度列是 sticky 的，
  // 它的视觉位置就是内容位置，所以直接减两个 rect 的 left 即可
  const gutter = first.getBoundingClientRect().left - g.getBoundingClientRect().left;
  const idx = (Number(D.parseISO(iso).getDay()) + 6) % 7;   // 周一 = 0
  const want = gutter + idx * colW - (g.clientWidth - colW) / 2;
  g.scrollLeft = Math.max(0, Math.min(want, g.scrollWidth - g.clientWidth));
}

/**
 * 视图尺寸 + 滚动位置。
 *
 * 滚动位置必须在**渲染阶段**读：React 是先跑完整棵树的 render、再统一改 DOM，
 * 所以 render 期间 DOM 还是旧的，这时读到的才是重绘前的位置。
 * 放进 effect 读到的已经是新内容的 scrollTop（被清零了），永远存成 0。
 */
export function useViewLayout(
  contentRef: React.RefObject<HTMLElement | null>,
  key: string,
  nav: string,
  view: string,
  cursor: string,
): void {
  const saved = useRef({ scroll: 0, week: 0, key: '' });
  const el = contentRef.current;

  if (el) {
    saved.current.scroll = el.scrollTop;
    const g = el.querySelector<HTMLElement>('.week-view');
    saved.current.week = g ? g.scrollTop : 0;
  }

  useLayoutEffect(() => {
    const host = contentRef.current;
    if (!host) return;

    const fit = () => {
      const wv = host.querySelector<HTMLElement>('.week-view');
      if (wv) {
        const head = wv.querySelector('.week-head');
        // 表头实测高度写成变量：下面那行 sticky 的 top 取的就是它，写死必错
        if (head) wv.style.setProperty('--week-head-h', head.getBoundingClientRect().height + 'px');
        wv.style.height = Math.max(420, availHeight(host)) + 'px';
      }
      const grid = host.querySelector<HTMLElement>('.month-grid');
      if (grid) {
        const row = Math.round(Math.max(
          MONTH_ROW_MIN,
          Math.min(MONTH_ROW_MAX, (availHeight(host) - MONTH_HEAD_H) / 6),
        ));
        grid.style.gridTemplateRows = '';
        // minmax(下限, auto)：下限保证尽量占满一屏，auto 让内容多的行自己长高 → 能滚
        grid.style.gridAutoRows = `minmax(${row}px, auto)`;
      }
    };

    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
    // 每次渲染都重跑：切视图 / 改窗口宽高都要重算，而这里是纯读写的便宜操作
  });

  useEffect(() => {
    const host = contentRef.current;
    if (!host) return;

    if (key === saved.current.key) {
      // 同一页面内的增删改保持原位 —— 勾选、拖动排序时画面不该突然跳走
      host.scrollTop = saved.current.scroll;
      const g = host.querySelector<HTMLElement>('.week-view');
      if (g) g.scrollTop = saved.current.week;
      return;
    }
    saved.current.key = key;

    /* 日视图锁单屏、不滚动，所以没有「定位到当前时间」这一步 ——
       整段可见，内容区不该再被 scrollTop 推走。 */
    if (nav === 'calendar' && view === 'week') {
      host.scrollTop = 0;
      const g = host.querySelector<HTMLElement>('.week-view');
      if (!g) return;
      // 早上别一上来就是半夜：9 点前先定位到 7:00
      const want = D.nowMin() < 7 * 60 ? 7 * 60 : D.nowMin();
      /* 按**可见窗口**那一屏折算，不再按整天：周视图现在可以只看某几个小时
         （见 WeekView），那几小时往往一屏就装得下，还按 DAY_H 算会一口气
         滚过头 —— 早上九点却停在下午。窗口那两端的分钟数就写在容器上。 */
      const cols = g.querySelector<HTMLElement>('.week-cols');
      const from = Number(cols?.dataset.from ?? 0);
      const to = Number(cols?.dataset.to ?? 1440);
      const boxH = cols?.getBoundingClientRect().height ?? DAY_H;
      const span = Math.max(1, to - from);
      const clamped = Math.max(from, Math.min(to, want));
      g.scrollTop = Math.max(0, ((clamped - from) / span) * boxH - 40);
      // 窄屏 7 列要横滑：把用户关心那天放在中间（只在真能横滑时才做）
      if (g.scrollWidth > g.clientWidth + 1) centerWeekDay(g, cursor);
    } else {
      host.scrollTop = 0;
    }
  }, [contentRef, key, nav, view, cursor]);
}
