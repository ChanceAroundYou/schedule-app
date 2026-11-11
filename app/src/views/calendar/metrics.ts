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
  /** 时间轴可用高度（px，已扣掉父容器 padding）。量不到时是 0 */
  boxH: number;
  /** 每小时多少像素（**整数**）。0 意味着还没挂上，别拿它做除法 */
  pxPerHour: number;
  /** 时间坐标总高 = pxPerHour × 小时数。0 = 还没量到，此时不设容器行高 */
  axisH: number;
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
    /* ⚠️ 量**父容器**（.week-grid / .timeline）而不是轴体自己。
       轴体的行高现在由 `axisH = pxPerHour × spanH` 显式给定（见下），
       再观察轴体就会形成「设高度 → 量到新高度 → 重算 → 再设」的反馈环，
       而且窗口缩放时轴体被固定住、不再跟着变。父容器由 flex 决定高度，
       不受子项行高影响，是唯一稳定的测量基准。
       父容器的 padding 是给最顶/最底那两个数字探出半个身位用的，
       不属于时间坐标，得先扣掉。 */
    const box = el.parentElement || el;
    const measure = () => {
      const cs = getComputedStyle(box);
      const avail = box.clientHeight
        - (parseFloat(cs.paddingTop) || 0)
        - (parseFloat(cs.paddingBottom) || 0);
      setBoxH(Math.max(0, avail));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [ref]);

  const spanH = spanOf(win) / 60;
  /* ⚠️ **必须取整**（2026-11-06 用户报「3 日 / 周视图横向细线严重抖动」）。
     原来这里是 `boxH / spanH`，而 boxH 是 flex 量出来的小数（实测 575.516），
     于是每格 = 23.979px。线和标签都按百分比定位，落点就永远踩在半像素上：
     浏览器逐帧抗锯齿时，同一条 1px 线的相位会左右漂 —— 看起来就是「线在抖、
     17:00 那个数字也在抖」，而全屏后高度正好凑整就消失了。
     取整之后线距恒定、落点全在整数像素上，抖动从源头消失。

     **余数的归宿（2026-11-12）**：向下取整后 `hourPx × spanH` 会比可用高度
     矮几像素。以前的做法是把最后一根线 / 最后一个数字单独钉到容器底
     （`--last` 特例），于是它的间距、标签与线的相对位置都和别人不一样 ——
     用户报「最底下那个数字完全在线的上方、间距过大」。
     现在反过来：**让时间轴的高度就等于 hourPx × spanH**（`axisH`），
     余数留在轴体下方作为统一留白。线、标签、竖线、卡片、现在线全用
     同一个坐标系，最后一根线按同一个公式算出来正好落在轴体底边，
     不需要任何特例。 */
  const hourPx = boxH > 0 ? Math.max(1, Math.floor(boxH / spanH)) : 40;
  /* 还没量到时不设行高（回退到 CSS 的 stretch），首帧不塌成 0 */
  const axisH = boxH > 0 ? Math.round(hourPx * spanH) : 0;
  const step = hourPx < 14 ? 3 : hourPx < 20 ? 2 : 1;
  /* `<=` 而非 `<`：把 dayTo 设成 22:00 时底部那条结束线得在 */
  const hours = hours24().filter((h) => h * 60 >= win.from && h * 60 <= win.to && h % step === 0);
  return { boxH, pxPerHour: hourPx, axisH, step, hours };
}
