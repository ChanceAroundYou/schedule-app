/**
 * metrics.ts —— 时间轴的「每厘米代表多久」
 *
 * ## 为什么抽出来（2026-10-17）
 *
 * 「一小时该画一条还是隔两小时画一条」这套判据，日视图写了一份、周视图
 * 从来没写过（它以前是纵向滚的，64px 一小时写死）。周视图锁成一屏之后，
 * 两个视图第一次遇上同一个问题：**时间轴的高度由 flex 决定、随时在变**。
 * 抄第二份必然只有一份跟着改，所以收到这里。
 *
 * 判据跟着**实际像素**走，不跟着小时数走：整天 24 小时在常见桌面高度下是
 * 21–29px/h，按小时数分档（>22 → step3）会让默认的整天视图永远停在最疏
 * 那一档（用户报过「密度太疏」）。只有真的挤在一起才跳档。
 */

import { useLayoutEffect, useState, type RefObject } from 'react';
import { spanOf, type DayWindow } from '../../domain/layout.ts';
import { hours24 } from './shared.ts';

export interface TimelineMetrics {
  /** 时间轴实测高度（px）。量不到时是 0 —— 调用方自己兜底 */
  boxH: number;
  /** 每小时多少像素。0 意味着还没挂上，别拿它做除法 */
  pxPerHour: number;
  /** 刻度抽稀档位：1 每小时一条，2 隔小时一条，3 三小时一条 */
  step: number;
  /** 该画出来的那些整点（含 24:00 —— 一天最后一条线） */
  hours: number[];
}

export function useTimelineMetrics(win: DayWindow, ref: RefObject<HTMLElement | null>): TimelineMetrics {
  const [boxH, setBoxH] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setBoxH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  const pxPerHour = boxH > 0 ? boxH / (spanOf(win) / 60) : 40;
  const step = pxPerHour < 14 ? 3 : pxPerHour < 20 ? 2 : 1;
  /* `<=` 而非 `<`：把 dayTo 设成 22:00 时底部那条结束线得在 */
  const hours = hours24().filter((h) => h * 60 >= win.from && h * 60 <= win.to && h % step === 0);
  return { boxH, pxPerHour, step, hours };
}
