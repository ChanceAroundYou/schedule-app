/**
 * layout.ts —— 视图滚动位置
 *
 * 尺寸**不归这里管**：日/周/月三视图的高度全是纯 CSS（flex: 1 + min-height: 0
 * 填满内容区，月视图行高 grid-auto-rows: 1fr 均分）。以前这里量内容区高度再写成
 * 内联 style，窗口一缩就只剩写死的下限；2026-10-22 月视图宽窄屏统一锁单屏后，
 * 那套（fit + MONTH_ROW_MIN/MAX）整个删掉，让 CSS 说话。
 */

import { useEffect, useRef } from 'react';
import * as D from '../../domain/date.ts';

/**
 * 窄屏下周视图 7 列要横滑，把「今天 / 选中的那天」摆到可视区中间 ——
 * 一屏只看得见 5 天，不定位的话今天可能整个在屏幕外。
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
  /* 今日居中：可用宽度是「容器宽 - 刻度列」，列区从刻度列右边开始 */
  const avail = g.clientWidth - gutter;
  const want = idx * colW + colW / 2 - avail / 2;
  /* **吸附到整列边界**（2026-10-22）：一屏能看 5 天之后，居中会算出「半列」的
     位置 —— 左边那半列被 sticky 的刻度列压住，卡片只剩一两个字露出来，看着像
     坏了。取整到 colW 的倍数，就永远是「整列对齐」，今天仍然大致居中。 */
  const snapped = Math.round(want / colW) * colW;
  g.scrollLeft = Math.max(0, Math.min(snapped, g.scrollWidth - g.clientWidth));
}

/**
 * 视图滚动位置（尺寸归 CSS，见文件头）。
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
    /* 周视图现在只留横向位置（纵向不再滚 —— 三视图都锁单屏，见文件头注释） */
    const g = el.querySelector<HTMLElement>('.week-view');
    saved.current.week = g ? g.scrollLeft : 0;
  }

  useEffect(() => {
    const host = contentRef.current;
    if (!host) return;

    if (key === saved.current.key) {
      // 同一页面内的增删改保持原位 —— 勾选、拖动排序时画面不该突然跳走
      host.scrollTop = saved.current.scroll;
      const g = host.querySelector<HTMLElement>('.week-view');
      if (g) g.scrollLeft = saved.current.week;
      return;
    }
    saved.current.key = key;

    /* 日视图 / 周视图都锁单屏、不纵向滚，所以没有「定位到当前时间」这一步 ——
       整天可见，内容区不该被 scrollTop 推走。剩下要管的只有横向：窄屏 7 列
       要横滑，把用户关心那天放在中间（只在真能横滑时才做）。 */
    if (nav === 'calendar' && view === 'week') {
      const g = host.querySelector<HTMLElement>('.week-view');
      if (g && g.scrollWidth > g.clientWidth + 1) centerWeekDay(g, cursor);
    }
    host.scrollTop = 0;
  }, [contentRef, key, nav, view, cursor]);
}
