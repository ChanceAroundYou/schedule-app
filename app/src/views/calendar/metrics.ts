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
  /** 每小时多少像素（**整数**）。0 意味着还没挂上，别拿它做除法 */
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

  const spanH = spanOf(win) / 60;
  /* ⚠️ **必须取整**（2026-11-06 用户报「3 日 / 周视图横向细线严重抖动」）。
     原来这里是 `boxH / spanH`，而 boxH 是 flex 量出来的小数（实测 575.516），
     于是每格 = 23.979px。线和标签都按百分比定位，落点就永远踩在半像素上：
     浏览器逐帧抗锯齿时，同一条 1px 线的相位会左右漂 —— 看起来就是「线在抖、
     17:00 那个数字也在抖」，而全屏后高度正好凑整就消失了。
     取整之后线距恒定、落点全在整数像素上，抖动从源头消失。

     ⚠️ 2026-11-11 改成**向下**取整：以前用 Math.round，实测 477.56px 的容器
     算出 30px/h × 16h = 480px，末端整点线被推到容器外 2.44px —— 底部横线
     和日列竖线接不上，最后一个刻度数字也被圆角裁掉半截（真机截图实证）。
     floor 保证 `hourPx × spanH <= boxH`，所有中间线都落在容器内；
     末端那一根由 HourLines / TimeGutter 单独钉到容器底，两者用同一个底边。 */
  const hourPx = boxH > 0 ? Math.max(1, Math.floor(boxH / spanH)) : 40;
  const step = hourPx < 14 ? 3 : hourPx < 20 ? 2 : 1;
  /* `<=` 而非 `<`：把 dayTo 设成 22:00 时底部那条结束线得在 */
  const hours = hours24().filter((h) => h * 60 >= win.from && h * 60 <= win.to && h % step === 0);
  return { boxH, pxPerHour: hourPx, step, hours };
}
